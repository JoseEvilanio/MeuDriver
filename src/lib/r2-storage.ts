import { supabase } from './supabase'

const defaultPartSize = 100 * 1024 * 1024
const defaultPartConcurrency = 3
const retryDelays = [500, 1500, 4000]

function getPositiveIntegerSetting(value: string | undefined, fallback: number, minimum: number, maximum: number, label: string) {
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} deve ser um inteiro entre ${minimum} e ${maximum}.`)
  }
  return parsed
}

type UploadSession = {
  uploadSessionId: string
  fileId: string
  storageKey: string
  uploadId: string | null
  partSize: number
  partCount: number
  mode: 'single' | 'multipart'
  url: string | null
  fingerprint: string
}

type ListedPart = {
  partNumber: number
  etag: string
  size: number
}

type UploadPartsResponse = {
  uploadSessionId: string
  fileId: string
  storageKey: string
  uploadId: string | null
  totalSize: number
  partSize: number
  fingerprint: string
  parts: ListedPart[]
}

type ProgressUpdate = {
  sentBytes: number
  totalBytes: number
}

type LocalUploadSession = {
  uploadSessionId: string
  fileId: string
  fingerprint: string
  replaceFileId?: string
}

type R2FileMetadata = {
  id: string
  user_id: string
  original_name: string
  original_path: string
  storage_key: string
  bucket_name: string
  mime_type: string
  file_extension: string | null
  file_size: number
  etag: string | null
  storage_provider: 'cloudflare_r2'
  upload_status: 'completed'
  updated_at: string
  deleted_at: string | null
}

function uploadFingerprint(file: File, originalPath: string) {
  const sampleSize = 1024 * 1024
  const first = file.slice(0, Math.min(file.size, sampleSize))
  const last = file.size > sampleSize ? file.slice(Math.max(sampleSize, file.size - sampleSize)) : new Blob()
  return Promise.all([first.arrayBuffer(), last.arrayBuffer()]).then(async ([firstBytes, lastBytes]) => {
    const material = new Uint8Array(firstBytes.byteLength + lastBytes.byteLength)
    material.set(new Uint8Array(firstBytes))
    material.set(new Uint8Array(lastBytes), firstBytes.byteLength)
    const hash = await crypto.subtle.digest('SHA-256', material)
    const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${file.size}:${file.lastModified}:${originalPath}:${digest}`
  })
}

function localSessionKey(userId: string, fingerprint: string) {
  return `meudrive:r2-upload:${userId}:${fingerprint}`
}

async function invokeStorage<T>(action: string, payload: Record<string, unknown> = {}) {
  if (!supabase) {
    throw new Error('Configure o Supabase antes de acessar o Cloudflare R2.')
  }
  const { data, error } = await supabase.functions.invoke<T>('cloudflare-storage', {
    body: { action, ...payload },
  })
  if (error) {
    const context = error.context
    if (context instanceof Response) {
      const body: unknown = await context.clone().json().catch(() => null)
      if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
        throw new Error(body.error)
      }
    }
    throw error
  }
  if (data === null) {
    throw new Error('A função de armazenamento não retornou uma resposta.')
  }
  return data
}

function putWithProgress(url: string, blob: Blob, signal: AbortSignal, onProgress: (sent: number) => void) {
  return new Promise<string>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', url)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded)
      }
    }
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        const etag = request.getResponseHeader('ETag')
        resolve(etag ?? '')
      } else {
        reject(new Error(`O R2 recusou uma parte do arquivo (HTTP ${request.status}).`))
      }
    }
    request.onerror = () => reject(new Error('Falha de rede ao enviar uma parte do arquivo.'))
    request.onabort = () => reject(new DOMException('Upload pausado.', 'AbortError'))
    const abort = () => request.abort()
    if (signal.aborted) {
      reject(new DOMException('Upload pausado.', 'AbortError'))
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    request.onloadend = () => signal.removeEventListener('abort', abort)
    request.send(blob)
  })
}

async function getPartUrl(uploadSessionId: string, partNumber: number) {
  const response = await invokeStorage<{ urls: Array<{ partNumber: number; url: string }> }>('part-urls', {
    uploadSessionId,
    partNumbers: [partNumber],
  })
  const signedUrl = response.urls.find((item) => item.partNumber === partNumber)?.url
  if (!signedUrl) {
    throw new Error(`O servidor não retornou uma URL para a parte ${partNumber}.`)
  }
  return signedUrl
}

export async function uploadR2File(
  file: File,
  originalPath: string,
  userId: string,
  onProgress: (progress: ProgressUpdate) => void,
  signal: AbortSignal,
  replaceFileId?: string,
) {
  const uploadPartSize = getPositiveIntegerSetting(
    import.meta.env.VITE_R2_PART_SIZE_BYTES,
    defaultPartSize,
    5 * 1024 * 1024,
    5 * 1024 * 1024 * 1024,
    'VITE_R2_PART_SIZE_BYTES',
  )
  const uploadPartConcurrency = getPositiveIntegerSetting(
    import.meta.env.VITE_R2_PART_CONCURRENCY,
    defaultPartConcurrency,
    1,
    8,
    'VITE_R2_PART_CONCURRENCY',
  )
  const fingerprint = await uploadFingerprint(file, originalPath)
  const storageKey = localSessionKey(userId, fingerprint)
  const savedSession = localStorage.getItem(storageKey)
  let session: UploadSession | null = null
  let listedParts: ListedPart[] = []

  if (savedSession) {
    let parsed: LocalUploadSession | null = null
    try {
      const value: unknown = JSON.parse(savedSession)
      if (
        typeof value === 'object' &&
        value !== null &&
        'uploadSessionId' in value &&
        typeof value.uploadSessionId === 'string' &&
        'fileId' in value &&
        typeof value.fileId === 'string' &&
        'fingerprint' in value &&
        value.fingerprint === fingerprint &&
        ('replaceFileId' in value ? value.replaceFileId : undefined) === replaceFileId
      ) {
        parsed = value as LocalUploadSession
      }
    } catch {
      localStorage.removeItem(storageKey)
    }

    if (parsed) {
      let serverSession: UploadPartsResponse
      try {
        serverSession = await invokeStorage<UploadPartsResponse>('list-parts', {
          uploadSessionId: parsed.uploadSessionId,
        })
      } catch (listPartsError) {
        const status = await invokeStorage<{
          status: string
          fileId: string
          storageKey: string
          totalSize: number
          fingerprint: string
        }>('upload-status', { uploadSessionId: parsed.uploadSessionId })
        if (status.status === 'completed') {
          if (status.fingerprint !== fingerprint || status.totalSize !== file.size) {
            throw new Error('O arquivo concluído não corresponde à seleção atual.')
          }
          localStorage.removeItem(storageKey)
          return { fileId: status.fileId, storageKey: status.storageKey }
        }
        try {
          await invokeStorage('reconcile', { uploadSessionId: parsed.uploadSessionId })
          localStorage.removeItem(storageKey)
          return { fileId: status.fileId, storageKey: status.storageKey }
        } catch (reconciliationError) {
          const partsMessage = listPartsError instanceof Error ? listPartsError.message : 'falha ao listar partes'
          const recoveryMessage = reconciliationError instanceof Error ? reconciliationError.message : 'falha ao reconciliar o objeto'
          throw new Error(`Não foi possível consultar as partes (${partsMessage}) nem recuperar o objeto (${recoveryMessage}).`)
        }
      }
      if (
        serverSession.fingerprint !== fingerprint ||
        serverSession.totalSize !== file.size
      ) {
        throw new Error('O arquivo selecionado não corresponde à sessão multipart salva.')
      }
      session = {
        uploadSessionId: serverSession.uploadSessionId,
        fileId: serverSession.fileId,
        storageKey: serverSession.storageKey,
        uploadId: serverSession.uploadId,
        partSize: serverSession.partSize,
        partCount: Math.ceil(file.size / serverSession.partSize),
        mode: file.size === 0 ? 'single' : 'multipart',
        url: null,
        fingerprint,
      }
      listedParts = serverSession.parts
      if (file.size === 0) {
        const signed = await invokeStorage<{ url: string }>('single-url', {
          uploadSessionId: serverSession.uploadSessionId,
        })
        session.url = signed.url
      }
    }
  }

  if (!session) {
    session = await invokeStorage<UploadSession>('initiate', {
      originalPath,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      partSize: uploadPartSize,
      fingerprint,
      replaceFileId,
    })
    localStorage.setItem(storageKey, JSON.stringify({
      uploadSessionId: session.uploadSessionId,
      fileId: session.fileId,
      fingerprint,
      replaceFileId,
    } satisfies LocalUploadSession))
  }

  if (session.mode === 'single') {
    if (!session.url) {
      throw new Error('A URL assinada para o arquivo vazio expirou; reinicie o envio.')
    }
    await putWithProgress(session.url, file, signal, (sent) => onProgress({ sentBytes: sent, totalBytes: file.size }))
    await invokeStorage('finalize-single', { uploadSessionId: session.uploadSessionId })
    localStorage.removeItem(storageKey)
    return { fileId: session.fileId, storageKey: session.storageKey }
  }

  const uploadedPartNumbers = new Set(listedParts.map((part) => part.partNumber))
  const sentByPart = new Map<number, number>(
    listedParts.map((part) => [part.partNumber, part.size]),
  )
  const missingParts = Array.from({ length: session.partCount }, (_, index) => index + 1)
    .filter((partNumber) => !uploadedPartNumbers.has(partNumber))
  const publishProgress = () => {
    const sentBytes = [...sentByPart.values()].reduce((sum, sent) => sum + sent, 0)
    onProgress({ sentBytes: Math.min(sentBytes, file.size), totalBytes: file.size })
  }
  publishProgress()

  for (let offset = 0; offset < missingParts.length; offset += uploadPartConcurrency) {
    if (signal.aborted) {
      throw new DOMException('Upload pausado.', 'AbortError')
    }
    const batch = missingParts.slice(offset, offset + uploadPartConcurrency)
    const response = await invokeStorage<{ urls: Array<{ partNumber: number; url: string }> }>('part-urls', {
      uploadSessionId: session.uploadSessionId,
      partNumbers: batch,
    })
    const urls = new Map(response.urls.map((item) => [item.partNumber, item.url]))
    await Promise.all(batch.map(async (partNumber) => {
      const start = (partNumber - 1) * session!.partSize
      const chunk = file.slice(start, Math.min(start + session!.partSize, file.size))
      let completed = false
      for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        if (signal.aborted) {
          throw new DOMException('Upload pausado.', 'AbortError')
        }
        try {
          const url = attempt === 0
            ? urls.get(partNumber)
            : await getPartUrl(session!.uploadSessionId, partNumber)
          if (!url) {
            throw new Error(`O servidor não retornou uma URL para a parte ${partNumber}.`)
          }
          sentByPart.set(partNumber, 0)
          await putWithProgress(url, chunk, signal, (sent) => {
            sentByPart.set(partNumber, sent)
            publishProgress()
          })
          sentByPart.set(partNumber, chunk.size)
          publishProgress()
          completed = true
          break
        } catch (error) {
          if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            throw error
          }
          sentByPart.set(partNumber, 0)
          publishProgress()
          if (attempt === retryDelays.length) {
            throw error
          }
          await new Promise((resolve) => window.setTimeout(resolve, retryDelays[attempt]))
        }
      }
      if (!completed) {
        throw new Error(`Não foi possível enviar a parte ${partNumber}.`)
      }
    }))
  }

  try {
    await invokeStorage('complete', { uploadSessionId: session.uploadSessionId })
  } catch (completeError) {
    try {
      await invokeStorage('reconcile', { uploadSessionId: session.uploadSessionId })
    } catch (reconciliationError) {
      const completionMessage = completeError instanceof Error ? completeError.message : 'falha ao concluir no R2'
      const recoveryMessage = reconciliationError instanceof Error ? reconciliationError.message : 'falha ao reconciliar o catálogo'
      throw new Error(`Não foi possível concluir o upload (${completionMessage}) nem reconciliar o objeto (${recoveryMessage}).`)
    }
  }
  localStorage.removeItem(storageKey)
  return { fileId: session.fileId, storageKey: session.storageKey }
}

export async function getR2DownloadUrl(fileId: string, inline = false) {
  const response = await invokeStorage<{ url: string }>('download-url', { fileId, inline })
  return response.url
}

export async function deleteR2File(fileId: string) {
  await invokeStorage('delete-file', { fileId })
}

export async function updateR2FilePath(fileId: string, originalPath: string) {
  await invokeStorage('rename-file', { fileId, originalPath })
}

export async function listR2Files() {
  if (!supabase) {
    throw new Error('Configure o Supabase antes de consultar o catálogo R2.')
  }
  const rows: R2FileMetadata[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from('drive_files')
      .select('id, user_id, original_name, original_path, storage_key, bucket_name, mime_type, file_extension, file_size, etag, storage_provider, upload_status, updated_at, deleted_at')
      .eq('storage_provider', 'cloudflare_r2')
      .eq('upload_status', 'completed')
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .range(offset, offset + pageSize - 1)
    if (error) {
      throw error
    }
    rows.push(...(data as R2FileMetadata[]))
    if (data.length < pageSize) {
      return rows
    }
  }
}
