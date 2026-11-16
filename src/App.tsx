import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import {
  Cloud,
  ChevronDown,
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FolderOpen,
  HardDrive,
  LayoutDashboard,
  LogIn,
  RefreshCw,
  Settings,
  ShieldCheck,
  Upload,
  UserRound,
} from 'lucide-react'
import './App.css'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card } from './components/ui/card'
import { Input } from './components/ui/input'
import {
  clearCachedFiles,
  deleteCachedFile,
  listCachedFileMetadata,
  readCachedCatalog,
  readCachedFile,
  reconcileCachedFiles,
  saveCachedCatalog,
  saveCachedFile,
  type CachedFile,
} from './lib/local-cache'
import { storageBucket, supabase, supabaseAnonKey, supabaseUrl } from './lib/supabase'
import { FileDialog, type PreviewKind } from './components/file-dialog'

const TransferAnimation = lazy(async () => {
  const module = await import('./components/transfer-animation')
  return { default: module.TransferAnimation }
})

const LoginDialog = lazy(async () => {
  const module = await import('./components/login-dialog')
  return { default: module.LoginDialog }
})

const navItems = [
  { id: 'overview', label: 'Visão geral', icon: LayoutDashboard },
  { id: 'sync', label: 'Sincronização', icon: RefreshCw },
  { id: 'files', label: 'Arquivos', icon: FolderOpen },
  { id: 'security', label: 'Permissões', icon: ShieldCheck },
  { id: 'settings', label: 'Configuração', icon: Settings },
] as const

type StoredFile = {
  name: string
  path: string
  objectPath: string
  size: number
  updatedAt: string | null
  contentType: string
}

type StorageSnapshot = {
  files: StoredFile[]
  folders: string[]
}

const emptyStorageSnapshot: StorageSnapshot = { files: [], folders: [] }
const explorerPageSize = 10

function getFilePath(file: File) {
  return file.webkitRelativePath || file.name
}

function getStoragePath(path: string) {
  return path
    .split(/[\\/]/)
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
}

function decodeStoragePath(path: string) {
  return path
    .split('/')
    .map((segment) => {
      if (!/^x_(?:[0-9a-f]{2})+$/i.test(segment)) {
        return segment
      }

      const encoded = segment.slice(2)
      const bytes = new Uint8Array(encoded.length / 2)
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16)
      }
      const decoded = new TextDecoder().decode(bytes)
      return /^[A-Za-z0-9._-]+$/.test(decoded) ? segment : decoded
    })
    .join('/')
}

function getUploadIdentity(file: File) {
  return `${getFilePath(file)}:${file.size}:${file.lastModified}`
}

function getUploadJobId(files: File[]) {
  const identities = files.map(getUploadIdentity).sort()
  let hash = 14695981039346656037n

  for (const character of identities.join('\n')) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * 1099511628211n)
  }

  return hash.toString(16)
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatModifiedDate(value: string | null) {
  if (!value) {
    return 'Data indisponível'
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Data indisponível'
    : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

function formatTimeSince(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return `Atualizado há ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Atualizado há ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `Atualizado há ${hours} h`
}

function isRetryableStorageError(error: unknown) {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false
  }

  return typeof error.status === 'number' && [429, 500, 502, 503, 504].includes(error.status)
}

function getStorageFileName(path: string) {
  return path.split('/').pop() || path
}

function getFileExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex > 0 && dotIndex < fileName.length - 1
    ? fileName.slice(dotIndex).toLocaleLowerCase()
    : 'Sem extensão'
}

function isEditableTextFile(file: StoredFile) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return file.contentType.startsWith('text/') ||
    ['application/json', 'application/javascript', 'application/xml', 'application/yaml'].includes(file.contentType) ||
    ['bat', 'bash', 'c', 'conf', 'cpp', 'cs', 'css', 'csv', 'env', 'go', 'h', 'html', 'ini', 'java', 'js', 'jsx', 'json', 'log', 'md', 'php', 'ps1', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svg', 'toml', 'ts', 'tsx', 'tsv', 'txt', 'vue', 'xml', 'yaml', 'yml'].includes(extension)
}

function getPreviewKind(file: StoredFile): PreviewKind {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (file.contentType.startsWith('image/') || ['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(extension)) return 'image'
  if (file.contentType === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (file.contentType.startsWith('audio/') || ['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav'].includes(extension)) return 'audio'
  if (file.contentType.startsWith('video/') || ['mkv', 'mov', 'mp4', 'mpeg', 'webm'].includes(extension)) return 'video'
  return null
}

function getFileIcon(file: StoredFile) {
  const extension = file.name.split('.').pop()?.toLowerCase()

  if (file.contentType.startsWith('image/') || ['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(extension ?? '')) {
    return FileImage
  }
  if (['7z', 'gz', 'rar', 'tar', 'zip'].includes(extension ?? '')) return FileArchive
  if (['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav'].includes(extension ?? '')) return FileAudio
  if (['c', 'cpp', 'css', 'html', 'js', 'json', 'py', 'sql', 'ts', 'tsx', 'xml', 'yaml', 'yml'].includes(extension ?? '')) return FileCode
  if (['csv', 'ods', 'xls', 'xlsm', 'xlsx'].includes(extension ?? '')) return FileSpreadsheet
  if (['mkv', 'mov', 'mp4', 'mpeg', 'webm'].includes(extension ?? '')) return FileVideo
  if (['doc', 'docx', 'md', 'odt', 'pdf', 'rtf', 'txt'].includes(extension ?? '')) return FileText
  return FileIcon
}

function getResumableEndpoint(baseUrl: string) {
  const parsedUrl = new URL(baseUrl)
  const projectHostname = parsedUrl.hostname.replace(/\.supabase\.co$/, '')
  const hostname = projectHostname !== parsedUrl.hostname
    ? `${projectHostname}.storage.supabase.co`
    : parsedUrl.hostname

  return `${parsedUrl.protocol}//${hostname}/storage/v1/upload/resumable`
}

async function uploadLargeFile(
  file: File,
  objectPath: string,
  originalPath: string,
  userId: string,
  accessToken: string,
  upsert: boolean,
  onProgress: (sent: number, total: number) => void,
) {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('As configurações do Supabase não estão disponíveis.')
  }

  const { Upload } = await import('tus-js-client')
  const fingerprint = `meudrive:${userId}:${objectPath}:${getUploadIdentity(file)}`
  const upload = new Upload(file, {
    endpoint: getResumableEndpoint(supabaseUrl),
    retryDelays: [0, 3000, 5000, 10000, 20000],
    headers: {
      apikey: supabaseAnonKey,
      authorization: `Bearer ${accessToken}`,
      'x-upsert': String(upsert),
    },
    uploadDataDuringCreation: true,
    removeFingerprintOnSuccess: true,
    chunkSize: 6 * 1024 * 1024,
    metadata: {
      bucketName: storageBucket,
      objectName: objectPath,
      contentType: file.type || 'application/octet-stream',
      cacheControl: '3600',
      metadata: JSON.stringify({ originalPath }),
    },
    fingerprint: async () => fingerprint,
    onProgress,
  })

  const previousUploads = await upload.findPreviousUploads()
  return new Promise<void>((resolve, reject) => {
    if (previousUploads.length > 0) {
      upload.resumeFromPreviousUpload(previousUploads[previousUploads.length - 1])
    }

    upload.options.onError = reject
    upload.options.onSuccess = () => resolve()
    upload.start()
  })
}

function getUploadErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    const response = 'originalResponse' in error ? error.originalResponse : undefined
    if (response && typeof response === 'object' && 'getBody' in response && typeof response.getBody === 'function') {
      const body = response.getBody()
      try {
        const parsed: unknown = JSON.parse(body)
        if (typeof parsed === 'object' && parsed !== null && 'message' in parsed && typeof parsed.message === 'string') {
          return parsed.message
        }
        if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string') {
          return parsed.error
        }
      } catch {
        return body || error.message
      }
    }

    return error.message
  }

  return 'Não foi possível concluir o upload.'
}

function App() {
  const [activeView, setActiveView] = useState<(typeof navItems)[number]['id']>('overview')
  const [search, setSearch] = useState('')
  const [folderPages, setFolderPages] = useState<Record<string, number>>({})
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginOpen, setLoginOpen] = useState(false)
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [sessionEmail, setSessionEmail] = useState('')
  const [sessionUserId, setSessionUserId] = useState('')
  const [storageSnapshot, setStorageSnapshot] = useState<StorageSnapshot>(emptyStorageSnapshot)
  const [storageLoading, setStorageLoading] = useState(false)
  const [storageError, setStorageError] = useState('')
  const [storageActionMessage, setStorageActionMessage] = useState('')
  const [cacheMessage, setCacheMessage] = useState('')
  const [cachedFilePaths, setCachedFilePaths] = useState<Set<string>>(new Set())
  const [storageRefreshKey, setStorageRefreshKey] = useState(0)
  const [downloadingPath, setDownloadingPath] = useState('')
  const [dialogFile, setDialogFile] = useState<StoredFile | null>(null)
  const [fileDialogText, setFileDialogText] = useState('')
  const [fileDialogPreviewUrl, setFileDialogPreviewUrl] = useState('')
  const [fileDialogLoading, setFileDialogLoading] = useState(false)
  const [fileDialogSaving, setFileDialogSaving] = useState(false)
  const [fileDialogError, setFileDialogError] = useState('')
  const [fileDialogPreviewKind, setFileDialogPreviewKind] = useState<PreviewKind>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [imagePreviews, setImagePreviews] = useState<{ path: string; url: string }[]>([])
  const previewGeneration = useRef(0)
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState('')
  const [uploadMessageTone, setUploadMessageTone] = useState<'info' | 'success' | 'error'>('info')
  const [uploadProgress, setUploadProgress] = useState({ completed: 0, total: 0 })
  const [uploadByteProgress, setUploadByteProgress] = useState({ sent: 0, total: 0 })
  const [uploadComplete, setUploadComplete] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const refreshStorageRef = useRef<number | null>(null)
  const storageLoadingRef = useRef(false)
  const uploadInProgressRef = useRef(false)
  const refreshPendingRef = useRef(false)
  const loadGenerationRef = useRef(0)
  const fileDialogGenerationRef = useRef(0)

  const triggerStorageRefresh = () => {
    setSyncing(true)
    if (storageLoadingRef.current || uploadInProgressRef.current) {
      refreshPendingRef.current = true
      return
    }

    if (refreshStorageRef.current) {
      window.clearTimeout(refreshStorageRef.current)
    }

    refreshStorageRef.current = window.setTimeout(() => {
      refreshStorageRef.current = null
      if (storageLoadingRef.current || uploadInProgressRef.current) {
        refreshPendingRef.current = true
        return
      }

      setStorageRefreshKey((current) => current + 1)
    }, 1200)
  }

  const filteredFiles = useMemo(() => storageSnapshot.files.filter((file) =>
    !search || file.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  ), [search, storageSnapshot.files])
  const folderFilesByPath = useMemo(() => {
    const filesByPath = new Map<string, StoredFile[]>()

    for (const file of filteredFiles) {
      const parentPath = file.path.split('/').slice(0, -1).join('/')
      const files = filesByPath.get(parentPath) ?? []
      files.push(file)
      filesByPath.set(parentPath, files)
    }

    return filesByPath
  }, [filteredFiles])
  const explorerFolders = useMemo(() => {
    const folders = [...storageSnapshot.folders]
    if (folderFilesByPath.has('')) {
      folders.unshift('')
    }
    return folders
  }, [folderFilesByPath, storageSnapshot.folders])
  const totalStorageBytes = storageSnapshot.files.reduce((sum, file) => sum + file.size, 0)
  const recentFiles = useMemo(() => [...storageSnapshot.files]
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
    .slice(0, 4), [storageSnapshot.files])
  const uploadPercent = uploadByteProgress.total > 0
    ? Math.round((uploadByteProgress.sent / uploadByteProgress.total) * 100)
    : uploadProgress.total
      ? Math.round((uploadProgress.completed / uploadProgress.total) * 100)
      : 0

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!fileDialogPreviewUrl) {
      return
    }

    return () => URL.revokeObjectURL(fileDialogPreviewUrl)
  }, [fileDialogPreviewUrl])

  useEffect(() => {
    if (!supabase) {
      return
    }

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        throw error
      }

      setSessionEmail(data.session?.user?.email ?? '')
      setEmail(data.session?.user?.email ?? '')
      setSessionUserId(data.session?.user?.id ?? '')
      setStorageSnapshot(emptyStorageSnapshot)
      setStorageError('')
      setLastSyncedAt(null)
    }).catch((error: unknown) => {
      setStorageError(error instanceof Error ? error.message : 'Não foi possível verificar a sessão do Supabase.')
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionEmail(session?.user?.email ?? '')
      setEmail(session?.user?.email ?? '')
      setSessionUserId(session?.user?.id ?? '')
      setStorageSnapshot(emptyStorageSnapshot)
      setStorageError('')
      setLastSyncedAt(null)
    })

    return () => {
      subscription.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const supabaseClient = supabase
    if (!supabaseClient || !sessionUserId) {
      return
    }

    const channel = supabaseClient.channel(`meudriver-storage:${sessionUserId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'storage',
          table: 'objects',
          filter: `bucket_id=eq.${storageBucket}`,
        },
        () => {
          if (uploadInProgressRef.current) {
            refreshPendingRef.current = true
            return
          }

          triggerStorageRefresh()
        },
      )
      .subscribe()

    return () => {
      void supabaseClient.removeChannel(channel)
    }
  }, [sessionUserId])

  useEffect(() => {
    let cancelled = false
    const generation = ++loadGenerationRef.current

    const loadStorage = async () => {
      if (!supabase || !sessionUserId) {
        setStorageSnapshot(emptyStorageSnapshot)
        setStorageError('')
        setCacheMessage('')
        setCachedFilePaths(new Set())
        setStorageLoading(false)
        setSyncing(false)
        if (loadGenerationRef.current === generation) {
          storageLoadingRef.current = false
          refreshPendingRef.current = false
        }
        return
      }

      storageLoadingRef.current = true
      setStorageLoading(true)
      setSyncing(true)
      setStorageError('')
      setCacheMessage('')
      setCachedFilePaths(new Set())

      try {
        const [cachedCatalog, cachedFiles] = await Promise.all([
          readCachedCatalog<StorageSnapshot>(sessionUserId, storageBucket),
          listCachedFileMetadata(sessionUserId, storageBucket),
        ])

        if (!cancelled) {
          if (cachedCatalog) {
            setStorageSnapshot(cachedCatalog.snapshot)
            setLastSyncedAt(cachedCatalog.savedAt)
          }
          setCachedFilePaths(new Set(cachedFiles.map((cachedFile) => cachedFile.objectPath)))
        }
      } catch (error) {
        if (!cancelled) {
          setCacheMessage(`Cache local indisponível: ${error instanceof Error ? error.message : 'falha ao ler o IndexedDB.'}`)
        }
      }

      try {
        const files: StoredFile[] = []
        const folders = new Set<string>()
        const pageSize = 1000
        const storage = supabase.storage.from(storageBucket)

        const readFolder = async (storageFolder: string, relativeFolder: string): Promise<void> => {
          let offset = 0

          while (true) {
            let entries: Awaited<ReturnType<typeof storage.list>>['data'] = null
            for (let attempt = 0; attempt < 4; attempt += 1) {
              const { data, error } = await storage.list(storageFolder, {
                limit: pageSize,
                offset,
                sortBy: { column: 'name', order: 'asc' },
              })

              if (!error) {
                entries = data
                break
              }

              if (!isRetryableStorageError(error) || attempt === 3) {
                throw error
              }

              await new Promise((resolve) => window.setTimeout(resolve, 750 * (attempt + 1)))
            }

            if (entries === null) {
              throw new Error(`Não foi possível listar a pasta "${relativeFolder || 'raiz'}" após novas tentativas.`)
            }

            for (const entry of entries) {
              const relativePath = relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name
              const decodedPath = decodeStoragePath(relativePath)

              if (entry.id === null && entry.metadata === null) {
                folders.add(decodedPath)
                await readFolder(`${storageFolder}/${entry.name}`, relativePath)
                continue
              }

              const originalPath = entry.metadata &&
                typeof entry.metadata === 'object' &&
                'originalPath' in entry.metadata &&
                typeof entry.metadata.originalPath === 'string'
                ? entry.metadata.originalPath
                : decodedPath
              const metadataSize = entry.metadata && typeof entry.metadata === 'object' && 'size' in entry.metadata
                ? entry.metadata.size
                : 0
              const size = typeof metadataSize === 'number'
                ? metadataSize
                : typeof metadataSize === 'string'
                  ? Number(metadataSize) || 0
                  : 0
              const contentType = entry.metadata &&
                typeof entry.metadata === 'object' &&
                'mimetype' in entry.metadata &&
                typeof entry.metadata.mimetype === 'string'
                ? entry.metadata.mimetype
                : 'application/octet-stream'

              files.push({
                name: getStorageFileName(originalPath),
                path: originalPath,
                objectPath: `${storageFolder}/${entry.name}`,
                size,
                updatedAt: entry.updated_at ?? entry.created_at ?? null,
                contentType,
              })
            }

            if (entries.length < pageSize) {
              break
            }
            offset += entries.length
          }
        }

        await readFolder(sessionUserId, '')
        for (const file of files) {
          const segments = file.path.split('/')
          segments.slice(0, -1).forEach((_segment, index) => {
            folders.add(segments.slice(0, index + 1).join('/'))
          })
        }

        files.sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
        if (!cancelled) {
          const snapshot = { files, folders: [...folders].sort((left, right) => left.localeCompare(right)) }
          setStorageSnapshot(snapshot)
          setLastSyncedAt(Date.now())
        }

        const snapshot = { files, folders: [...folders].sort((left, right) => left.localeCompare(right)) }
        try {
          if (cancelled) {
            return
          }
          await saveCachedCatalog(sessionUserId, storageBucket, snapshot)
          const cachedPaths = await reconcileCachedFiles(
            sessionUserId,
            storageBucket,
            snapshot.files.map(({ objectPath, updatedAt, size }) => ({ objectPath, updatedAt, size })),
          )
          if (!cancelled) {
            setCachedFilePaths(cachedPaths)
            setCacheMessage('')
          }
        } catch (error) {
          if (!cancelled) {
            setCacheMessage(`Não foi possível atualizar o cache local: ${error instanceof Error ? error.message : 'erro desconhecido.'}`)
          }
        }
      } catch (error) {
        if (!cancelled) {
          setStorageError(error instanceof Error ? error.message : 'Não foi possível carregar os arquivos do Storage.')
        }
      } finally {
        if (!cancelled) {
          setStorageLoading(false)
          setSyncing(false)
        }

        if (loadGenerationRef.current === generation) {
          storageLoadingRef.current = false
          if (refreshPendingRef.current) {
            refreshPendingRef.current = false
            triggerStorageRefresh()
          }
        }
      }
    }

    void loadStorage()
    return () => {
      cancelled = true
    }
  }, [sessionUserId, storageRefreshKey])

  const handleAuth = async () => {
    if (!supabase) {
      setAuthMessage('Configure as variáveis VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY antes de testar a autenticação.')
      return
    }

    setIsSubmittingAuth(true)
    setAuthMessage('')

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password })

      if (error) {
        throw error
      }

      setAuthMessage('Login realizado com sucesso.')
      setPassword('')
      setLoginOpen(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao autenticar com o Supabase.'
      setAuthMessage(message)
    } finally {
      setIsSubmittingAuth(false)
    }
  }

  const handleSignOut = async () => {
    if (!supabase) {
      return
    }

    setAuthMessage('')
    try {
      const { error } = await supabase.auth.signOut()
      if (error) {
        throw error
      }
      setSessionEmail('')
      setAuthMessage('Sessão encerrada.')
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Não foi possível encerrar a sessão.')
    }
  }

  const refreshStorage = () => {
    setStorageActionMessage('')
    triggerStorageRefresh()
  }

  const clearLocalCache = async () => {
    if (!sessionUserId) {
      return
    }

    if (!window.confirm('Remover o catálogo local e os arquivos em cache deste usuário neste navegador?')) {
      return
    }

    try {
      await clearCachedFiles(sessionUserId, storageBucket)
      setCachedFilePaths(new Set())
      setCacheMessage('Cache local removido deste navegador.')
    } catch (error) {
      setCacheMessage(`Não foi possível limpar o cache local: ${error instanceof Error ? error.message : 'erro desconhecido.'}`)
    }
  }

  const getStoredFileBlob = async (file: StoredFile) => {
    if (!supabase) {
      throw new Error('Configure o Supabase antes de abrir ou baixar arquivos.')
    }

    let cachedFile: CachedFile | null = null
    try {
      cachedFile = await readCachedFile(sessionUserId, storageBucket, file.objectPath)
    } catch (error) {
      setCacheMessage(`Não foi possível ler o cache local: ${error instanceof Error ? error.message : 'erro desconhecido.'}`)
    }

    if (cachedFile &&
      cachedFile.metadata.updatedAt === file.updatedAt &&
      cachedFile.metadata.size === file.size
    ) {
      setStorageActionMessage(`"${file.name}" foi recuperado do cache local.`)
      return cachedFile.blob
    }

    try {
      const { data, error } = await supabase.storage.from(storageBucket).download(file.objectPath)
      if (error) {
        throw error
      }

      try {
        await saveCachedFile(
          sessionUserId,
          storageBucket,
          file.objectPath,
          file.updatedAt,
          file.size,
          data,
        )
        setCachedFilePaths((paths) => new Set(paths).add(file.objectPath))
        setCacheMessage('')
      } catch (error) {
        setCacheMessage(`O arquivo foi baixado, mas não foi possível guardá-lo no cache: ${error instanceof Error ? error.message : 'erro desconhecido.'}`)
      }
      return data
    } catch (error) {
      if (!cachedFile) {
        throw error
      }

      setStorageActionMessage(`Sem conexão com o Storage. Foi usada a cópia local de "${file.name}", que pode estar desatualizada.`)
      return cachedFile.blob
    }
  }

  const downloadStoredFile = async (file: StoredFile) => {
    setDownloadingPath(file.objectPath)
    setStorageActionMessage('')
    try {
      const fileBlob = await getStoredFileBlob(file)
      const downloadUrl = URL.createObjectURL(fileBlob)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = file.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
    } catch (error) {
      setStorageActionMessage(error instanceof Error ? error.message : `Não foi possível baixar "${file.path}".`)
    } finally {
      setDownloadingPath('')
    }
  }

  const closeFileDialog = (open: boolean) => {
    if (open) {
      return
    }

    fileDialogGenerationRef.current += 1
    setDialogFile(null)
    setFileDialogPreviewUrl('')
    setFileDialogError('')
  }

  const openStoredFile = async (file: StoredFile) => {
    const generation = ++fileDialogGenerationRef.current
    const editable = isEditableTextFile(file)
    setDialogFile(file)
    setFileDialogText('')
    setFileDialogPreviewUrl('')
    setFileDialogPreviewKind(editable ? null : getPreviewKind(file))
    setFileDialogLoading(true)
    setFileDialogError('')
    setStorageActionMessage('')
    setDownloadingPath(file.objectPath)

    try {
      const blob = await getStoredFileBlob(file)
      if (fileDialogGenerationRef.current !== generation) {
        return
      }

      if (editable) {
        setFileDialogText(await blob.text())
      } else {
        setFileDialogPreviewUrl(URL.createObjectURL(blob))
      }
    } catch (error) {
      if (fileDialogGenerationRef.current === generation) {
        setFileDialogError(error instanceof Error ? error.message : `Não foi possível abrir "${file.path}".`)
      }
    } finally {
      if (fileDialogGenerationRef.current === generation) {
        setFileDialogLoading(false)
        setDownloadingPath('')
      }
    }
  }

  const replaceStoredFile = async (file: StoredFile, replacement: File) => {
    if (!supabase) {
      setFileDialogError('Configure o Supabase antes de atualizar arquivos.')
      return false
    }
    if (uploadInProgressRef.current) {
      setFileDialogError('Aguarde a transferência atual terminar antes de atualizar este arquivo.')
      return false
    }

    setFileDialogSaving(true)
    setFileDialogError('')
    uploadInProgressRef.current = true
    let saved = false

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) {
        throw sessionError
      }
      const session = sessionData.session
      if (!session || session.user.id !== sessionUserId) {
        throw new Error('Faça login novamente para atualizar este arquivo.')
      }
      if (!file.objectPath.startsWith(`${session.user.id}/`)) {
        throw new Error('O arquivo não pertence à conta autenticada.')
      }

      if (replacement.size > 6 * 1024 * 1024) {
        await uploadLargeFile(
          replacement,
          file.objectPath,
          file.path,
          session.user.id,
          session.access_token,
          true,
          () => undefined,
        )
      } else {
        const { error } = await supabase.storage.from(storageBucket).upload(file.objectPath, replacement, {
          cacheControl: '3600',
          upsert: true,
          contentType: replacement.type || file.contentType || 'application/octet-stream',
          metadata: { originalPath: file.path },
        })
        if (error) {
          throw error
        }
      }

      saved = true
      setStorageActionMessage(`"${file.name}" foi atualizado no Storage.`)
      try {
        await deleteCachedFile(session.user.id, storageBucket, file.objectPath)
      } catch (error) {
        setCacheMessage(`O arquivo foi atualizado, mas não foi possível invalidar a cópia local: ${error instanceof Error ? error.message : 'erro desconhecido.'}`)
      }
      return true
    } catch (error) {
      setFileDialogError(error instanceof Error ? error.message : `Não foi possível atualizar "${file.path}".`)
      return false
    } finally {
      uploadInProgressRef.current = false
      setFileDialogSaving(false)
      if (saved || refreshPendingRef.current) {
        refreshPendingRef.current = false
        triggerStorageRefresh()
      }
    }
  }

  const saveEditedText = async () => {
    if (!dialogFile) {
      return
    }

    const replacement = new File([fileDialogText], dialogFile.name, {
      type: dialogFile.contentType || 'text/plain',
    })
    if (await replaceStoredFile(dialogFile, replacement)) {
      closeFileDialog(false)
    }
  }

  const downloadDialogFile = () => {
    if (dialogFile) {
      void downloadStoredFile(dialogFile)
    }
  }

  const handleUpload = async () => {
    if (!supabase || selectedFiles.length === 0) {
      setUploadMessage('Selecione um ou mais arquivos, ou uma pasta, antes de enviar.')
      setUploadMessageTone('error')
      return
    }
    if (uploadInProgressRef.current) {
      setUploadMessage('Aguarde a transferência atual terminar antes de iniciar outro envio.')
      setUploadMessageTone('error')
      return
    }

    setUploading(true)
    uploadInProgressRef.current = true
    setUploadMessage('')
    setUploadMessageTone('info')
    setUploadComplete(false)
    setUploadProgress({ completed: 0, total: selectedFiles.length })
    const totalBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0)
    setUploadByteProgress({ sent: 0, total: totalBytes })
    let uploadedCount = 0
    let completedBytes = 0
    let currentPath = ''
    let progressKey = ''
    let completed = new Set<string>()

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) {
        throw sessionError
      }

      if (!sessionData.session) {
        setUploadMessage('Faça login no app antes de enviar arquivos. A política do Storage permite uploads somente para usuários autenticados.')
        setUploadMessageTone('error')
        return
      }

      const userId = sessionData.session.user.id
      setSessionEmail(sessionData.session.user.email ?? '')
      progressKey = `meudrive:upload:${userId}:${getUploadJobId(selectedFiles)}`
      const savedProgress = localStorage.getItem(progressKey)
      if (savedProgress) {
        const parsedProgress: unknown = JSON.parse(savedProgress)
        if (
          typeof parsedProgress === 'object' &&
          parsedProgress !== null &&
          'completed' in parsedProgress &&
          Array.isArray(parsedProgress.completed) &&
          parsedProgress.completed.every((item) => typeof item === 'string')
        ) {
          completed = new Set(parsedProgress.completed)
        }
      }

      currentPath = 'verificação de nomes'
      setUploadMessage('Verificando se as pastas ou arquivos já existem no Supabase...')
      const storage = supabase.storage.from(storageBucket)
      const pageSize = 1000
      const readStoragePage = async (storageFolder: string, offset: number) => {
        let entries: Awaited<ReturnType<typeof storage.list>>['data'] = null
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const { data, error } = await storage.list(storageFolder, {
            limit: pageSize,
            offset,
            sortBy: { column: 'name', order: 'asc' },
          })

          if (!error) {
            entries = data
            break
          }
          if (!isRetryableStorageError(error) || attempt === 3) {
            throw error
          }
          await new Promise((resolve) => window.setTimeout(resolve, 750 * (attempt + 1)))
        }

        if (entries === null) {
          throw new Error(`Não foi possível verificar a pasta "${storageFolder}" antes do envio.`)
        }
        return entries
      }

      const existingRootEntries = new Map<string, Array<{ name: string; isFolder: boolean }>>()
      let rootOffset = 0
      while (true) {
        const entries = await readStoragePage(userId, rootOffset)
        for (const entry of entries) {
          const name = decodeStoragePath(entry.name)
          const rootEntries = existingRootEntries.get(name) ?? []
          rootEntries.push({
            name: entry.name,
            isFolder: entry.id === null && entry.metadata === null,
          })
          existingRootEntries.set(name, rootEntries)
        }
        if (entries.length < pageSize) {
          break
        }
        rootOffset += entries.length
      }

      const pathsInBatch = new Set<string>()
      const repeatedPaths = new Set<string>()
      const filesByRoot = new Map<string, Array<{ path: string; identity: string }>>()
      for (const file of selectedFiles) {
        const path = getStoragePath(getFilePath(file))
        const identity = getUploadIdentity(file)
        if (pathsInBatch.has(path)) {
          repeatedPaths.add(path)
        }
        pathsInBatch.add(path)
        const rootName = path.split('/')[0]
        const rootFiles = filesByRoot.get(rootName) ?? []
        rootFiles.push({ path, identity })
        filesByRoot.set(rootName, rootFiles)
      }

      const conflicts = new Set<string>()
      const readExistingPaths = async (
        storageFolder: string,
        relativeFolder: string,
        paths: Set<string>,
      ): Promise<void> => {
        let offset = 0
        while (true) {
          const entries = await readStoragePage(storageFolder, offset)
          for (const entry of entries) {
            const relativePath = relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name
            if (entry.id === null && entry.metadata === null) {
              await readExistingPaths(`${storageFolder}/${entry.name}`, relativePath, paths)
            } else {
              paths.add(decodeStoragePath(relativePath))
            }
          }
          if (entries.length < pageSize) {
            break
          }
          offset += entries.length
        }
      }

      for (const [rootName, rootFiles] of filesByRoot) {
        const existingEntries = existingRootEntries.get(rootName)
        if (!existingEntries) {
          continue
        }

        const rootCompletedPaths = new Set(rootFiles
          .filter(({ identity }) => completed.has(identity))
          .map(({ path }) => path))
        const includesFolder = rootFiles.some(({ path }) => path.includes('/'))
        const includesRootFile = rootFiles.some(({ path }) => !path.includes('/'))
        const mixedBatchKinds = includesFolder && includesRootFile
        const existing = existingEntries.length === 1 ? existingEntries[0] : null
        let canResumeThisFolder = false

        if (existing?.isFolder && includesFolder && !includesRootFile && rootCompletedPaths.size > 0) {
          const existingPaths = new Set<string>()
          await readExistingPaths(`${userId}/${existing.name}`, existing.name, existingPaths)
          canResumeThisFolder = existingPaths.size > 0 &&
            [...existingPaths].every((path) => rootCompletedPaths.has(path)) &&
            [...rootCompletedPaths].every((path) => existingPaths.has(path))
        } else if (existing && !existing.isFolder && !includesFolder && !mixedBatchKinds) {
          canResumeThisFolder = rootFiles.every(({ path, identity }) =>
            path === rootName && completed.has(identity),
          )
        }

        if (existingEntries.length > 1 || mixedBatchKinds || !canResumeThisFolder) {
          conflicts.add(rootName)
        }
      }

      if (conflicts.size > 0 || repeatedPaths.size > 0) {
        const names = [...conflicts].slice(0, 5).join('", "')
        const moreNames = conflicts.size > 5 ? ` e mais ${conflicts.size - 5}` : ''
        const messages: string[] = []
        if (conflicts.size > 0) {
          messages.push(`Já existe uma pasta ou arquivo com o nome "${names}"${moreNames} no Supabase.`)
        }
        if (repeatedPaths.size > 0) {
          messages.push(`O lote selecionado contém ${repeatedPaths.size} caminho(s) duplicado(s).`)
        }
        setUploadMessage(`${messages.join(' ')} Nenhum arquivo foi enviado. Altere o nome da pasta ou do arquivo e selecione novamente.`)
        setUploadMessageTone('error')
        return
      }

      uploadedCount = Math.min(completed.size, selectedFiles.length)
      completedBytes = selectedFiles
        .filter((file) => completed.has(getUploadIdentity(file)))
        .reduce((sum, file) => sum + file.size, 0)
      setUploadProgress({ completed: uploadedCount, total: selectedFiles.length })
      setUploadByteProgress({ sent: completedBytes, total: totalBytes })

      for (const file of selectedFiles) {
        currentPath = getFilePath(file)
        const identity = getUploadIdentity(file)
        if (completed.has(identity)) {
          setUploadMessage(`Retomando envio: ${uploadedCount} de ${selectedFiles.length} arquivo(s) já concluídos.`)
          setUploadMessageTone('info')
          continue
        }

        setUploadMessage(`Enviando ${uploadedCount + 1} de ${selectedFiles.length}: ${currentPath}`)
        setUploadMessageTone('info')

        const relativePath = getStoragePath(currentPath)
        const storagePath = `${userId}/${relativePath}`
        if (file.size > 6 * 1024 * 1024) {
          await uploadLargeFile(
            file,
            storagePath,
            currentPath,
            userId,
            sessionData.session.access_token,
            false,
            (sent) => setUploadByteProgress({ sent: completedBytes + sent, total: totalBytes }),
          )
        } else {
          const { error } = await supabase.storage.from(storageBucket).upload(storagePath, file, {
            cacheControl: '3600',
            upsert: false,
            contentType: file.type || undefined,
            metadata: { originalPath: currentPath },
          })

          if (error) {
            throw error
          }
        }

        uploadedCount += 1
        completedBytes += file.size
        completed.add(identity)
        setUploadProgress({ completed: uploadedCount, total: selectedFiles.length })
        setUploadByteProgress({ sent: completedBytes, total: totalBytes })
        localStorage.setItem(progressKey, JSON.stringify({ completed: [...completed] }))
      }

      localStorage.removeItem(progressKey)
      setUploadComplete(true)
      setUploadByteProgress({ sent: totalBytes, total: totalBytes })
      setUploadMessage(`${uploadedCount} arquivo(s) enviado(s) para o bucket "${storageBucket}", mantendo a estrutura de pastas.`)
      setUploadMessageTone('success')
    } catch (error) {
      const message = getUploadErrorMessage(error)
      const normalizedMessage = message.toLowerCase()
      const details = normalizedMessage.includes('already exists') || normalizedMessage.includes('duplicate')
        ? `Já existe um objeto com esse nome no Supabase. Nenhum arquivo existente foi substituído. Altere o nome da pasta ou do arquivo e tente novamente.`
        : normalizedMessage.includes('exceeded the maximum allowed size') || normalizedMessage.includes('maximum allowed size')
        ? `O arquivo ultrapassa o limite máximo permitido pelo Supabase para o bucket "${storageBucket}". O envio resumível foi usado, mas ele não remove o limite de tamanho. Aumente o limite em Storage > Buckets > ${storageBucket} (e confira o limite global em Storage > Settings) para um valor acima do tamanho desse arquivo; o máximo também depende do plano Supabase. Depois tente enviar novamente.`
        : normalizedMessage.includes('bucket not found')
        ? `O bucket "${storageBucket}" não existe neste projeto Supabase. Crie esse bucket em Storage > Buckets ou ajuste VITE_SUPABASE_BUCKET no arquivo .env para o nome de um bucket existente; depois reinicie o servidor.`
        : normalizedMessage.includes('row-level security')
          ? `A sessão está autenticada, mas uma política RLS bloqueou o upload ou a substituição. No SQL Editor do projeto lvolditiynfaaufxfhel, aplique supabase/migrations/20261111073500_user_scoped_upserts.sql.`
        : message

      setUploadMessage(`Upload interrompido após ${uploadedCount} de ${selectedFiles.length} arquivo(s). Falha em "${currentPath}": ${details}`)
      setUploadMessageTone('error')
    } finally {
      uploadInProgressRef.current = false
      setUploading(false)
      if (uploadedCount > 0) {
        setSearch('')
        setFolderPages({})
        setExpandedFolders(new Set(
          selectedFiles.map((file) => getFilePath(file).split('/').slice(0, -1).join('/')),
        ))
        setActiveView('files')
      }
      if (uploadedCount > 0 || refreshPendingRef.current) {
        refreshPendingRef.current = false
        triggerStorageRefresh()
      }
    }
  }

  const addSelectedFiles = (fileList: FileList | null) => {
    if (!fileList) {
      return
    }

    const incomingFiles = Array.from(fileList)
    const existingPaths = new Set(selectedFiles.map((file) => `${getFilePath(file)}:${file.size}:${file.lastModified}`))
    const newFiles = incomingFiles.filter((file) => {
      const identity = `${getFilePath(file)}:${file.size}:${file.lastModified}`
      if (existingPaths.has(identity)) {
        return false
      }
      existingPaths.add(identity)
      return true
    })
    const generation = previewGeneration.current

    setSelectedFiles((currentFiles) => [...currentFiles, ...newFiles])
    if (newFiles.length > 0) {
      setUploadComplete(false)
      setUploadProgress({ completed: 0, total: selectedFiles.length + newFiles.length })
      setUploadByteProgress({
        sent: 0,
        total: [...selectedFiles, ...newFiles].reduce((sum, file) => sum + file.size, 0),
      })
    }

    newFiles
      .filter((file) => file.type.startsWith('image/'))
      .forEach((file) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result
          if (generation === previewGeneration.current && typeof result === 'string') {
            const path = getFilePath(file)
            setImagePreviews((currentPreviews) => [
              ...currentPreviews.filter((preview) => preview.path !== path),
              { path, url: result },
            ])
          }
        }
        reader.readAsDataURL(file)
      })

    setUploadMessage('')
    setUploadMessageTone('info')
  }

  const renderOverview = () => (
    <>
      <section className="hero-panel panel">
        <div>
          <p className={`eyebrow ${sessionUserId && !storageError ? 'success' : ''}`}>
            {storageError ? 'Erro ao acessar o Storage' : storageLoading ? 'Atualizando dados da nuvem' : sessionUserId ? 'Conta conectada ao Storage' : 'Login necessário'}
          </p>
          <h2>Arquivos reais da sua conta</h2>
          <p className="lead">
            Consulte os objetos e pastas do bucket Supabase associados à sua sessão. O catálogo local aparece rapidamente e é atualizado por eventos Realtime ou ao sincronizar manualmente.
          </p>
        </div>

        <div className="status-card">
          <span className="status-label">Bucket configurado</span>
          <strong>{storageBucket}</strong>
          <span className="status-meta">{sessionEmail || 'Entre para consultar seus arquivos'}</span>
        </div>
      </section>

      <section className="stats-grid" aria-label="Estatísticas principais">
        {[
          { label: 'Arquivos na nuvem', value: sessionUserId && !storageLoading && !storageError ? storageSnapshot.files.length.toLocaleString('pt-BR') : '—', accent: 'blue' },
          { label: 'Pastas encontradas', value: sessionUserId && !storageLoading && !storageError ? storageSnapshot.folders.length.toLocaleString('pt-BR') : '—', accent: 'green' },
          { label: 'Espaço utilizado', value: sessionUserId && !storageLoading && !storageError ? formatFileSize(totalStorageBytes) : '—', accent: 'violet' },
          { label: 'Conta autenticada', value: sessionEmail ? 'Sim' : 'Não', accent: 'orange' },
        ].map((stat) => (
          <article key={stat.label} className={`stat-card ${stat.accent}`}>
            <p>{stat.label}</p>
            <strong>{stat.value}</strong>
          </article>
        ))}
      </section>

      <section className="content-grid">
        <article className="panel">
          <div className="panel-header">
            <h3>Pastas no bucket</h3>
            <span className="badge neutral">
              {storageLoading ? 'Carregando...' : sessionUserId && !storageError ? `${storageSnapshot.folders.length} encontradas` : '—'}
            </span>
          </div>

          <div className="folder-list">
            {storageSnapshot.folders.length > 0
              ? storageSnapshot.folders.slice(0, 5).map((folder) => (
                <div key={folder} className="folder-row">
                  <div>
                    <h4>{getStorageFileName(folder)}</h4>
                    <small>{folder}</small>
                  </div>
                  <div className="folder-meta">
                    <span className="status-pill">No Storage</span>
                  </div>
                </div>
              ))
              : <p className="empty-state">{storageLoading ? 'Carregando pastas...' : !sessionUserId ? 'Entre para consultar suas pastas.' : storageError ? 'Não foi possível carregar as pastas.' : 'Nenhuma pasta encontrada nesta conta.'}</p>}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <h3>Envio atual</h3>
            <span className={`badge ${uploading ? 'accent' : 'neutral'}`}>{uploading ? 'Em andamento' : 'Sem fila ativa'}</span>
          </div>

          <div className="mini-card">
            <span className="eyebrow">Lote selecionado</span>
            <h4>{uploading ? `${uploadProgress.completed} de ${uploadProgress.total} enviados` : `${selectedFiles.length} arquivo(s)`}</h4>
            <p>{uploadMessage || (uploadComplete ? 'Último envio concluído.' : 'A fila existe somente enquanto este app está aberto.')}</p>
          </div>
        </article>
      </section>

      <section className="lower-grid">
        <article className="panel">
          <div className="panel-header">
            <h3>Arquivos recentes</h3>
            <Button type="button" variant="outline" size="sm" onClick={refreshStorage} disabled={!sessionUserId || syncing}>
              <RefreshCw size={14} aria-hidden="true" className={syncing ? 'spin' : ''} />
              {syncing ? 'Sincronizando...' : 'Atualizar'}
            </Button>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Modificado</th>
                  <th>Tamanho</th>
                  <th>Tipo</th>
                </tr>
              </thead>
              <tbody>
                {recentFiles.length > 0
                  ? recentFiles.map((file) => (
                    <tr key={file.objectPath}>
                      <td title={file.path}>
                        <button
                          type="button"
                          className="storage-file-name file-open-button"
                          onClick={() => void openStoredFile(file)}
                          aria-label={`Abrir ${file.path}`}
                        >
                          {file.name}
                        </button>
                      </td>
                      <td>{formatModifiedDate(file.updatedAt)}</td>
                      <td>{formatFileSize(file.size)}</td>
                      <td>{file.contentType}</td>
                    </tr>
                  ))
                  : <tr><td colSpan={4}>{storageLoading ? 'Carregando arquivos...' : !sessionUserId ? 'Entre para consultar seus arquivos.' : storageError ? 'Não foi possível carregar os arquivos.' : 'Nenhum arquivo encontrado nesta conta.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <h3><Cloud size={16} aria-hidden="true" /> Estado da conexão</h3>
            <span className={`badge ${storageError ? 'neutral' : sessionUserId ? 'accent' : 'neutral'}`}>
              {storageError ? 'Erro' : sessionUserId ? 'Conectado' : 'Desconectado'}
            </span>
          </div>

          <p className="muted">
            {storageError || (!supabase
              ? 'Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY para habilitar o Storage.'
              : !sessionUserId
                ? 'Entre com sua conta para consultar os objetos permitidos pelas políticas do Storage.'
                : 'Os dados exibidos vêm do bucket configurado e do escopo de acesso da sessão atual.')}
          </p>
          {storageActionMessage && <p className="status-message">{storageActionMessage}</p>}
        </article>
      </section>

    </>
  )

  const renderSync = () => (
    <section className="panel">
      <div className="panel-header">
        <h3>Sincronização com a nuvem</h3>
        <Button type="button" variant="outline" size="sm" onClick={refreshStorage} disabled={!sessionUserId || syncing}>
          <RefreshCw size={14} aria-hidden="true" className={syncing ? 'spin' : ''} />
          {syncing ? 'Sincronizando...' : 'Atualizar dados'}
        </Button>
      </div>

      <p className="sync-status" role="status" aria-live="polite">
        {syncing ? 'Sincronizando arquivos...' : lastSyncedAt ? formatTimeSince(lastSyncedAt, clock) : 'Aguardando a primeira sincronização.'}
      </p>

      <div className="sync-layout">
        <div className="mini-card">
          <span className="eyebrow">Conexão</span>
          <h4>{storageError ? 'Falha ao carregar' : storageLoading ? 'Consultando...' : sessionUserId ? 'Conectado' : 'Sem sessão'}</h4>
          <p>{storageError || sessionEmail || 'Entre para consultar o armazenamento.'}</p>
        </div>
        <div className="mini-card">
          <span className="eyebrow">Objetos no Storage</span>
          <h4>{sessionUserId && !storageLoading && !storageError ? `${storageSnapshot.files.length.toLocaleString('pt-BR')} arquivos` : '—'}</h4>
          <p>{sessionUserId && !storageLoading && !storageError ? `${formatFileSize(totalStorageBytes)} no bucket ${storageBucket}` : storageError || 'Aguardando uma sessão válida.'}</p>
        </div>
        <div className="mini-card">
          <span className="eyebrow">Envio desta sessão</span>
          <h4>{uploading ? `${uploadPercent}%` : uploadComplete ? 'Concluído' : 'Inativo'}</h4>
          <p>{uploading ? `${uploadProgress.completed} de ${uploadProgress.total} arquivos concluídos` : uploadMessage || 'Nenhuma fila persistente está configurada.'}</p>
        </div>
      </div>

      <p className="muted mt">
        O catálogo é guardado neste navegador e os arquivos baixados ficam disponíveis no cache local do perfil. O conteúdo em cache pode ser reutilizado, mas o navegador pode removê-lo se precisar de espaço; esta versão ainda não sincroniza uma pasta do Windows nem mantém uma fila de alterações offline.
      </p>
    </section>
  )

  const renderFiles = () => (
    <section className="panel">
      <div className="panel-header">
        <h3>Explorador de arquivos</h3>
        <div className="toolbar">
          <span className="badge neutral">{storageLoading || storageError || !sessionUserId ? '—' : `${filteredFiles.length} arquivo(s)`}</span>
          <Button type="button" variant="outline" size="sm" onClick={refreshStorage} disabled={!sessionUserId || syncing}>
            <RefreshCw size={14} aria-hidden="true" className={syncing ? 'spin' : ''} />
            {syncing ? 'Sincronizando...' : 'Atualizar'}
          </Button>
        </div>
      </div>

      <div className="toolbar inline-toolbar">
        <Input
          className="search-box"
          type="text"
          placeholder="Pesquisar arquivos"
          value={search}
          onChange={(event) => {
            setFolderPages({})
            setSearch(event.target.value)
          }}
        />
        <Button type="button" size="sm" onClick={() => document.querySelector('.supabase-panel')?.scrollIntoView({ behavior: 'smooth' })}>
          <Upload size={14} aria-hidden="true" />
          Ir para envio
        </Button>
      </div>

      <p className="muted">Arquivos visíveis para {sessionEmail || 'a conta autenticada'}, no bucket {storageBucket}.</p>
      {storageError && <p className="status-message">{storageError}</p>}
      {storageActionMessage && <p className="status-message">{storageActionMessage}</p>}
      {cacheMessage && <p className="status-message">{cacheMessage}</p>}

      <div className="folder-dropdown-list">
        {explorerFolders.map((folder) => {
          const folderFiles = folderFilesByPath.get(folder) ?? []
          const folderPageCount = Math.max(1, Math.ceil(folderFiles.length / explorerPageSize))
          const currentFolderPage = Math.min(folderPages[folder] ?? 1, folderPageCount)
          const folderPageFiles = folderFiles.slice(
            (currentFolderPage - 1) * explorerPageSize,
            currentFolderPage * explorerPageSize,
          )

          return (
            <details
              className="folder-dropdown"
              key={folder || '__root__'}
              open={expandedFolders.has(folder)}
              onToggle={(event) => {
                const isOpen = event.currentTarget.open
                setExpandedFolders((current) => {
                  if (current.has(folder) === isOpen) {
                    return current
                  }
                  const next = new Set(current)
                  if (isOpen) {
                    next.add(folder)
                  } else {
                    next.delete(folder)
                  }
                  return next
                })
              }}
            >
              <summary>
                <FolderOpen size={17} aria-hidden="true" />
                <span className="folder-dropdown-name">{folder || 'Arquivos na raiz'}</span>
                <span className="badge neutral">{folderFiles.length} arquivo(s)</span>
                <ChevronDown className="folder-dropdown-chevron" size={16} aria-hidden="true" />
              </summary>
              <div className="folder-dropdown-content">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Arquivo</th>
                        <th>Extensão</th>
                        <th>Tamanho</th>
                        <th>Modificado</th>
                        <th>Ação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {folderPageFiles.length > 0 ? folderPageFiles.map((file) => {
                        const FileTypeIcon = getFileIcon(file)

                        return (
                          <tr key={file.objectPath}>
                            <td>
                              <div className="storage-file-cell" title={file.path}>
                                <span className="storage-file-icon" aria-hidden="true">
                                  <FileTypeIcon size={18} strokeWidth={1.7} />
                                </span>
                                <button
                                  type="button"
                                  className="storage-file-name file-open-button"
                                  onClick={() => void openStoredFile(file)}
                                  aria-label={`Abrir ${file.path}`}
                                >
                                  {file.name}
                                </button>
                                {cachedFilePaths.has(file.objectPath) && <span className="badge accent">Neste navegador</span>}
                              </div>
                            </td>
                            <td>{getFileExtension(file.name)}</td>
                            <td>{formatFileSize(file.size)}</td>
                            <td>{formatModifiedDate(file.updatedAt)}</td>
                            <td>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void downloadStoredFile(file)}
                                disabled={downloadingPath === file.objectPath}
                                aria-label={`Baixar ${file.path}`}
                              >
                                <Download size={14} aria-hidden="true" />
                                {downloadingPath === file.objectPath
                                  ? 'Preparando...'
                                  : cachedFilePaths.has(file.objectPath)
                                    ? 'Baixar (local)'
                                    : 'Baixar'}
                              </Button>
                            </td>
                          </tr>
                        )
                      }) : (
                        <tr>
                          <td colSpan={5}>
                            {search ? 'Nenhum arquivo desta pasta corresponde à busca.' : 'Esta pasta não contém arquivos.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="file-pagination">
                  <span>
                    {folderFiles.length === 0
                      ? '0 arquivos'
                      : `Exibindo ${(currentFolderPage - 1) * explorerPageSize + 1}–${Math.min(currentFolderPage * explorerPageSize, folderFiles.length)} de ${folderFiles.length} arquivo(s)`}
                  </span>
                  <div className="file-pagination-controls">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setFolderPages((pages) => ({
                        ...pages,
                        [folder]: Math.max(1, currentFolderPage - 1),
                      }))}
                      disabled={currentFolderPage <= 1 || storageLoading}
                      aria-label={`Página anterior da pasta ${folder}`}
                    >
                      Anterior
                    </Button>
                    <span aria-live="polite">Página {currentFolderPage} de {folderPageCount}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setFolderPages((pages) => ({
                        ...pages,
                        [folder]: Math.min(folderPageCount, currentFolderPage + 1),
                      }))}
                      disabled={currentFolderPage >= folderPageCount || storageLoading}
                      aria-label={`Próxima página da pasta ${folder}`}
                    >
                      Próxima
                    </Button>
                  </div>
                </div>
              </div>
            </details>
          )
        })}
        {!storageLoading && !storageError && sessionUserId && explorerFolders.length === 0 && (
          <p className="muted">
            {search
              ? 'Nenhum arquivo corresponde à busca.'
              : 'Nenhuma pasta ou arquivo encontrado nesta conta.'}
          </p>
        )}
      </div>
    </section>
  )

  const renderSecurity = () => (
    <section className="panel">
      <div className="panel-header">
        <h3>Conta e acesso ao armazenamento</h3>
        <span className={`badge ${sessionUserId ? 'accent' : 'neutral'}`}>{sessionUserId ? 'Autenticado' : 'Sem sessão'}</span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Informação</th>
              <th>Valor atual</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Usuário autenticado</td><td>{sessionEmail || 'Nenhum'}</td></tr>
            <tr><td>Bucket</td><td>{storageBucket}</td></tr>
            <tr><td>Objetos acessíveis nesta sessão</td><td>{storageError ? 'Falha ao consultar' : storageLoading ? 'Consultando...' : storageSnapshot.files.length.toLocaleString('pt-BR')}</td></tr>
            <tr><td>Controle de acesso</td><td>Supabase Auth e RLS configurada no projeto</td></tr>
          </tbody>
        </table>
      </div>
      <p className="muted mt">Perfis, empresas e permissões individuais não são exibidos porque não há uma tabela de autorização corporativa conectada neste projeto.</p>
    </section>
  )

  const renderSettings = () => (
    <section className="panel">
      <div className="panel-header">
        <h3>Configuração da integração</h3>
        <Button type="button" variant="outline" size="sm" onClick={refreshStorage} disabled={!sessionUserId || syncing}>
          <RefreshCw size={14} aria-hidden="true" className={syncing ? 'spin' : ''} />
          {syncing ? 'Sincronizando...' : 'Verificar conexão'}
        </Button>
      </div>

      <div className="settings-list">
        <div className="setting-row"><span>Configuração do Supabase</span><strong>{supabase ? 'Configurado' : 'Não configurado'}</strong></div>
        <div className="setting-row"><span>Bucket de arquivos</span><strong>{storageBucket}</strong></div>
        <div className="setting-row"><span>Conta da sessão</span><strong>{sessionEmail || 'Não conectada'}</strong></div>
        <div className="setting-row"><span>Transferência disponível</span><strong>Upload, edição e download manuais</strong></div>
        <div className="setting-row"><span>Arquivos em cache local</span><strong>{cachedFilePaths.size} neste navegador</strong></div>
      </div>
      {cacheMessage && <p className="status-message">{cacheMessage}</p>}
      <Button type="button" variant="outline" size="sm" onClick={() => void clearLocalCache()} disabled={!sessionUserId}>
        Limpar cache local
      </Button>
      <p className="muted mt">A URL e a chave pública são lidas de VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY. Nenhuma credencial secreta deve ser colocada no frontend. O cache fica no perfil deste navegador e não é criptografado pelo app.</p>
    </section>
  )

  const renderCurrentView = () => {
    switch (activeView) {
      case 'sync':
        return renderSync()
      case 'files':
        return renderFiles()
      case 'security':
        return renderSecurity()
      case 'settings':
        return renderSettings()
      default:
        return renderOverview()
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-wrap">
          <img className="brand-mark" src="/meudriver-icon.png" alt="" aria-hidden="true" />
          <div>
            <p className="eyebrow">MeuDrive</p>
            <strong>Workspace</strong>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Navegação lateral">
          {navItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className={item.id === activeView ? 'side-link active' : 'side-link'}
              aria-current={item.id === activeView ? 'page' : undefined}
              onClick={() => setActiveView(item.id)}
            >
              <item.icon size={16} strokeWidth={1.8} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-card">
          <span className="eyebrow">CONTA</span>
          <h3 title={sessionEmail || 'Conta não conectada'}>{sessionEmail || 'Conta não conectada'}</h3>
          <p><span className={`online-indicator ${sessionUserId ? '' : 'offline'}`} />{storageError ? 'Falha ao carregar arquivos' : storageLoading ? 'Carregando arquivos...' : sessionUserId ? `${storageSnapshot.files.length} arquivos no bucket` : 'Faça login para sincronizar'}</p>
        </div>

        <Button
          type="button"
          variant={sessionEmail ? 'outline' : 'default'}
          className="sidebar-login-button"
          aria-haspopup="dialog"
          aria-expanded={loginOpen}
          onClick={() => {
            setAuthMessage('')
            setLoginOpen(true)
          }}
        >
          {sessionEmail ? <UserRound size={16} aria-hidden="true" /> : <LogIn size={16} aria-hidden="true" />}
          {sessionEmail ? 'Minha conta' : 'Entrar'}
        </Button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Painel de sincronização</p>
            <h1>{navItems.find((item) => item.id === activeView)?.label}</h1>
          </div>

          <div className="toolbar">
            <span className={`sync-status-badge ${syncing ? 'is-syncing' : ''}`} role="status" aria-live="polite">
              {syncing
                ? 'Sincronizando...'
                : lastSyncedAt
                  ? formatTimeSince(lastSyncedAt, clock)
                  : 'Ainda não sincronizado'}
            </span>
            <Button type="button" variant="outline" onClick={() => setActiveView('files')}>
              <FolderOpen size={15} aria-hidden="true" />
              Explorar arquivos
            </Button>
            <Button type="button" onClick={refreshStorage} disabled={!sessionUserId || syncing}>
              <RefreshCw size={15} aria-hidden="true" className={syncing ? 'spin' : ''} />
              {syncing ? 'Sincronizando...' : 'Sincronizar agora'}
            </Button>
          </div>
        </header>

        <Card className="supabase-panel panel">
          <div className="panel-header align-start">
            <div>
              <h3><Cloud size={17} aria-hidden="true" /> Transferência de arquivos</h3>
              <p className="muted">
                {supabase ? 'Selecione arquivos ou uma pasta para enviar ao armazenamento.' : 'Configure as chaves do projeto para ativar o armazenamento.'}
              </p>
            </div>
            {sessionEmail ? (
              <Badge variant="secondary" className="badge accent">Logado como {sessionEmail}</Badge>
            ) : (
              <Badge variant="outline" className="badge neutral">Entre para enviar</Badge>
            )}
          </div>

          <div className="upload-workspace">
            <div className="auth-card upload-card">
              <div className="auth-card-title">
                <Upload size={16} aria-hidden="true" />
                <strong>Enviar arquivos</strong>
              </div>
              <div className="upload-picker">
                <span className="upload-label">Arquivos e pastas</span>
                <div className="upload-actions">
                  <label className="ghost-button small upload-picker-button">
                    <FileText size={14} aria-hidden="true" />
                    Escolher arquivos
                    <input
                      className="upload-input-hidden"
                      type="file"
                      multiple
                      onChange={(event) => {
                        addSelectedFiles(event.target.files)
                        event.target.value = ''
                      }}
                    />
                  </label>
                  <label className="ghost-button small upload-picker-button">
                    <FolderOpen size={14} aria-hidden="true" />
                    Escolher pasta
                    <input
                      className="upload-input-hidden"
                      type="file"
                      multiple
                      ref={(element) => element?.setAttribute('webkitdirectory', '')}
                      onChange={(event) => {
                        addSelectedFiles(event.target.files)
                        event.target.value = ''
                      }}
                    />
                  </label>
                </div>
                <p className="upload-help">Imagens, documentos e outros arquivos. Pastas mantêm a estrutura de subpastas.</p>
              </div>

              {selectedFiles.length > 0 && (
                <div className="selected-files">
                  <div className="selected-files-heading">
                    <strong>{selectedFiles.length} arquivo(s) selecionado(s)</strong>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        previewGeneration.current += 1
                        setSelectedFiles([])
                        setImagePreviews([])
                        setUploadMessage('')
                        setUploadMessageTone('info')
                        setUploadProgress({ completed: 0, total: 0 })
                        setUploadByteProgress({ sent: 0, total: 0 })
                        setUploadComplete(false)
                      }}
                      disabled={uploading}
                    >
                      Limpar
                    </button>
                  </div>
                  <ul className="selected-file-list">
                    {selectedFiles.map((file, index) => {
                      const path = getFilePath(file)
                      const preview = imagePreviews.find((item) => item.path === path)

                      return (
                        <li key={`${path}:${file.size}:${file.lastModified}:${index}`}>
                          {preview ? (
                            <img className="file-thumbnail" src={preview.url} alt={`Prévia de ${file.name}`} />
                          ) : (
                            <span className="file-thumbnail file-icon" aria-hidden="true">
                              {file.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE'}
                            </span>
                          )}
                          <span className="selected-file-name" title={path}>{path}</span>
                          <small>{formatFileSize(file.size)}</small>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className="upload-meta">
                <span><HardDrive size={14} aria-hidden="true" /> Bucket atual</span>
                <strong>{storageBucket}</strong>
              </div>

              <Button type="button" size="sm" onClick={handleUpload} disabled={!supabase || selectedFiles.length === 0 || uploading || fileDialogSaving}>
                <Upload size={14} aria-hidden="true" />
                {uploading ? 'Enviando...' : !supabase ? 'Supabase não configurado' : `Enviar ${selectedFiles.length || ''} arquivo(s)`}
              </Button>

              {!supabase && (
                <p className="status-message upload-feedback error" role="alert">
                  O envio está desativado porque o app não recebeu a configuração do Supabase. Na Vercel, cadastre
                  {' '}VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY em Settings → Environment Variables e faça um novo deploy.
                  Não use a chave service_role no frontend.
                </p>
              )}
              {supabase && selectedFiles.length === 0 && (
                <p className="status-message upload-feedback info" role="status">
                  Selecione um ou mais arquivos para habilitar o envio.
                </p>
              )}
              {uploadMessage && (
                <p
                  className={`status-message upload-feedback ${uploadMessageTone}`}
                  role={uploadMessageTone === 'error' ? 'alert' : 'status'}
                  aria-live={uploadMessageTone === 'error' ? 'assertive' : 'polite'}
                >
                  {uploadMessage}
                </p>
              )}

              <Suspense fallback={<div className="transfer-illustration-placeholder" aria-hidden="true" />}>
                <TransferAnimation active={uploading} complete={uploadComplete} progress={uploadPercent} />
              </Suspense>

              <div className="transfer-progress-copy" aria-live="polite">
                <span>Arquivos transferidos</span>
                <strong>{uploadProgress.completed} <span>de</span> {uploadProgress.total} · {uploadPercent}%</strong>
              </div>
              <div
                className="transfer-progress-track"
                role="progressbar"
                aria-label="Progresso da transferência"
                aria-valuemin={0}
                aria-valuemax={uploadByteProgress.total || 100}
                aria-valuenow={uploadByteProgress.sent}
                aria-valuetext={`${uploadProgress.completed} de ${uploadProgress.total} arquivos, ${uploadPercent}%`}
              >
                <div
                  className="transfer-progress-value"
                  style={{ width: `${uploadPercent}%` }}
                />
              </div>
            </div>
          </div>
        </Card>

        {renderCurrentView()}
      </main>

      {loginOpen && (
        <Suspense fallback={null}>
          <LoginDialog
            open={loginOpen}
            onOpenChange={setLoginOpen}
            email={email}
            password={password}
            sessionEmail={sessionEmail}
            message={authMessage}
            isSubmitting={isSubmittingAuth}
            isConfigured={Boolean(supabase)}
            onEmailChange={setEmail}
            onPasswordChange={setPassword}
            onSubmit={() => void handleAuth()}
            onSignOut={() => void handleSignOut()}
          />
        </Suspense>
      )}
      <FileDialog
        file={dialogFile}
        text={fileDialogText}
        previewUrl={fileDialogPreviewUrl}
        previewKind={fileDialogPreviewKind}
        loading={fileDialogLoading}
        saving={fileDialogSaving}
        error={fileDialogError}
        statusMessage={storageActionMessage}
        isEditable={dialogFile ? isEditableTextFile(dialogFile) : false}
        onOpenChange={closeFileDialog}
        onTextChange={setFileDialogText}
        onSave={() => void saveEditedText()}
        onReplace={(replacement) => {
          if (dialogFile) {
            void replaceStoredFile(dialogFile, replacement).then((saved) => {
              if (saved) {
                closeFileDialog(false)
              }
            })
          }
        }}
        onDownload={downloadDialogFile}
      />
    </div>
  )
}

export default App
