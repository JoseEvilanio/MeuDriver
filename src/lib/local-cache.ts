const databaseName = 'meudrive-local-cache'
const databaseVersion = 1
const catalogStoreName = 'catalog'
const fileMetadataStoreName = 'file-metadata'
const fileBlobStoreName = 'file-blobs'
const scopeIndexName = 'scope'
let databasePromise: Promise<IDBDatabase> | null = null

type CatalogRecord<T> = {
  key: string
  userId: string
  bucket: string
  snapshot: T
  savedAt: number
}

type CachedBlobRecord = {
  key: string
  blob: Blob
}

export type CachedFileMetadata = {
  key: string
  scope: string
  objectPath: string
  updatedAt: string | null
  size: number
}

export type CachedFile = {
  metadata: CachedFileMetadata
  blob: Blob
}

function getScopeKey(userId: string, bucket: string) {
  return JSON.stringify([userId, bucket])
}

function getFileKey(userId: string, bucket: string, objectPath: string) {
  return JSON.stringify([userId, bucket, objectPath])
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('Este navegador não oferece armazenamento IndexedDB.'))
  }

  if (databasePromise) {
    return databasePromise
  }

  const pendingDatabase = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(catalogStoreName)) {
        database.createObjectStore(catalogStoreName, { keyPath: 'key' })
      }
      if (!database.objectStoreNames.contains(fileMetadataStoreName)) {
        const store = database.createObjectStore(fileMetadataStoreName, { keyPath: 'key' })
        store.createIndex(scopeIndexName, 'scope')
      }
      if (!database.objectStoreNames.contains(fileBlobStoreName)) {
        database.createObjectStore(fileBlobStoreName, { keyPath: 'key' })
      }
    }

    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close()
        databasePromise = null
      }
      resolve(request.result)
    }
    request.onerror = () => reject(request.error ?? new Error('Não foi possível abrir o cache local.'))
    request.onblocked = () => reject(new Error('O cache local está bloqueado por outra aba. Feche outras abas do MeuDrive e tente novamente.'))
  }).catch((error: unknown): never => {
    databasePromise = null
    throw error
  })

  databasePromise = pendingDatabase
  return pendingDatabase
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Falha ao acessar o cache local.'))
  })
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('A operação do cache local falhou.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('A operação do cache local foi cancelada.'))
  })
}

export async function readCachedCatalog<T>(userId: string, bucket: string) {
  const database = await openDatabase()
  const transaction = database.transaction(catalogStoreName, 'readonly')
  const completed = transactionComplete(transaction)
  const record = await requestResult(transaction.objectStore(catalogStoreName).get(getScopeKey(userId, bucket))) as CatalogRecord<T> | undefined
  await completed
  return record
}

export async function saveCachedCatalog<T>(userId: string, bucket: string, snapshot: T) {
  const database = await openDatabase()
  const transaction = database.transaction(catalogStoreName, 'readwrite')
  const completed = transactionComplete(transaction)
  transaction.objectStore(catalogStoreName).put({
    key: getScopeKey(userId, bucket),
    userId,
    bucket,
    snapshot,
    savedAt: Date.now(),
  } satisfies CatalogRecord<T>)
  await completed
}

export async function listCachedFileMetadata(userId: string, bucket: string) {
  const database = await openDatabase()
  const transaction = database.transaction(fileMetadataStoreName, 'readonly')
  const completed = transactionComplete(transaction)
  const index = transaction.objectStore(fileMetadataStoreName).index(scopeIndexName)
  const records = await requestResult(index.getAll(getScopeKey(userId, bucket))) as CachedFileMetadata[]
  await completed
  return records
}

export async function readCachedFile(userId: string, bucket: string, objectPath: string) {
  const key = getFileKey(userId, bucket, objectPath)
  const database = await openDatabase()
  const transaction = database.transaction([fileMetadataStoreName, fileBlobStoreName], 'readonly')
  const completed = transactionComplete(transaction)
  const metadataRequest = transaction.objectStore(fileMetadataStoreName).get(key)
  const blobRequest = transaction.objectStore(fileBlobStoreName).get(key)
  const [metadata, blobRecord] = await Promise.all([
    requestResult(metadataRequest),
    requestResult(blobRequest),
  ]) as [CachedFileMetadata | undefined, CachedBlobRecord | undefined]
  await completed

  return metadata && blobRecord ? { metadata, blob: blobRecord.blob } satisfies CachedFile : null
}

export async function saveCachedFile(
  userId: string,
  bucket: string,
  objectPath: string,
  updatedAt: string | null,
  size: number,
  blob: Blob,
) {
  const key = getFileKey(userId, bucket, objectPath)
  const database = await openDatabase()
  const transaction = database.transaction([fileMetadataStoreName, fileBlobStoreName], 'readwrite')
  const completed = transactionComplete(transaction)

  transaction.objectStore(fileMetadataStoreName).put({
    key,
    scope: getScopeKey(userId, bucket),
    objectPath,
    updatedAt,
    size,
  } satisfies CachedFileMetadata)
  transaction.objectStore(fileBlobStoreName).put({ key, blob })

  await completed
}

export async function reconcileCachedFiles(
  userId: string,
  bucket: string,
  files: Array<{ objectPath: string; updatedAt: string | null; size: number }>,
) {
  const database = await openDatabase()
  const readTransaction = database.transaction(fileMetadataStoreName, 'readonly')
  const readCompleted = transactionComplete(readTransaction)
  const metadata = await requestResult(
    readTransaction.objectStore(fileMetadataStoreName).index(scopeIndexName).getAll(getScopeKey(userId, bucket)),
  ) as CachedFileMetadata[]
  await readCompleted

  const remoteFiles = new Map(files.map((file) => [file.objectPath, file]))
  const staleRecords = metadata
    .filter((cached) => {
      const remote = remoteFiles.get(cached.objectPath)
      return !remote || remote.updatedAt !== cached.updatedAt || remote.size !== cached.size
    })
  const stalePaths = new Set(staleRecords.map((cached) => cached.objectPath))

  if (staleRecords.length > 0) {
    const writeTransaction = database.transaction([fileMetadataStoreName, fileBlobStoreName], 'readwrite')
    const writeCompleted = transactionComplete(writeTransaction)
    for (const cached of staleRecords) {
      writeTransaction.objectStore(fileMetadataStoreName).delete(cached.key)
      writeTransaction.objectStore(fileBlobStoreName).delete(cached.key)
    }
    await writeCompleted
  }

  const cachedPaths = new Set(metadata
    .filter((cached) => !stalePaths.has(cached.objectPath))
    .map((cached) => cached.objectPath))
  return cachedPaths
}

export async function deleteCachedFile(userId: string, bucket: string, objectPath: string) {
  const key = getFileKey(userId, bucket, objectPath)
  const database = await openDatabase()
  const transaction = database.transaction([fileMetadataStoreName, fileBlobStoreName], 'readwrite')
  const completed = transactionComplete(transaction)
  transaction.objectStore(fileMetadataStoreName).delete(key)
  transaction.objectStore(fileBlobStoreName).delete(key)
  await completed
}

export async function clearCachedFiles(userId: string, bucket: string) {
  const database = await openDatabase()
  const readTransaction = database.transaction(fileMetadataStoreName, 'readonly')
  const readCompleted = transactionComplete(readTransaction)
  const metadata = await requestResult(
    readTransaction.objectStore(fileMetadataStoreName).index(scopeIndexName).getAll(getScopeKey(userId, bucket)),
  ) as CachedFileMetadata[]
  await readCompleted

  const writeTransaction = database.transaction([catalogStoreName, fileMetadataStoreName, fileBlobStoreName], 'readwrite')
  const writeCompleted = transactionComplete(writeTransaction)
  writeTransaction.objectStore(catalogStoreName).delete(getScopeKey(userId, bucket))
  for (const record of metadata) {
    writeTransaction.objectStore(fileMetadataStoreName).delete(record.key)
    writeTransaction.objectStore(fileBlobStoreName).delete(record.key)
  }
  await writeCompleted
}
