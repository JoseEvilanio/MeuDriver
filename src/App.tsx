import { Suspense, lazy, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  CheckCircle2,
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
  KeyRound,
  Mail,
  Pencil,
  RefreshCw,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
  UserRound,
  UserPlus,
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
import { appUrl, storageBucket, supabase, supabaseAnonKey, supabaseUrl } from './lib/supabase'
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

type AccessRole = 'master' | 'manager' | 'collaborator'

type ManagedUser = {
  id: string
  email: string | null
  role: AccessRole
  created_at: string
}

const emptyStorageSnapshot: StorageSnapshot = { files: [], folders: [] }
const explorerPageSize = 10
const masterEmail = 'jose_evilanio@hotmail.com'

function getCachedSupabaseSnapshot(snapshot: StorageSnapshot): StorageSnapshot {
  const files = snapshot.files.filter((file) => !('provider' in file) || file.provider === 'supabase')
  const folders = new Set<string>()
  for (const file of files) {
    const segments = file.path.split('/')
    segments.slice(0, -1).forEach((_segment, index) => {
      folders.add(segments.slice(0, index + 1).join('/'))
    })
  }
  return { files, folders: [...folders].sort((left, right) => left.localeCompare(right)) }
}

function getFilePath(file: File) {
  return file.webkitRelativePath || file.name
}

const validStoragePathSegment = /^[A-Za-z0-9_!.*'() &$=@;:+,?-]+$/

function getStoragePath(path: string) {
  return path
    .split(/[\\/]/)
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map((segment) => {
      if (validStoragePathSegment.test(segment) && !segment.startsWith('x_')) {
        return segment
      }

      const hex = Array.from(new TextEncoder().encode(segment), (byte) => byte.toString(16).padStart(2, '0')).join('')
      return `x_${hex}`
    })
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
      return /^[A-Za-z0-9._-]+$/.test(decoded) && !decoded.startsWith('x_') ? segment : decoded
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

function getResumableEndpoint(baseUrl: string) {
  const parsedUrl = new URL(baseUrl)
  const projectHostname = parsedUrl.hostname.replace(/\.supabase\.co$/, '')
  const hostname = projectHostname !== parsedUrl.hostname
    ? `${projectHostname}.storage.supabase.co`
    : parsedUrl.hostname

  return `${parsedUrl.protocol}//${hostname}/storage/v1/upload/resumable`
}

async function uploadSupabaseResumableFile(
  file: File,
  objectPath: string,
  originalPath: string,
  userId: string,
  accessToken: string,
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal,
  upsert: boolean,
) {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('As configurações do Supabase não estão disponíveis.')
  }

  const { Upload } = await import('tus-js-client')
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
    fingerprint: async () => `meudrive:${userId}:${objectPath}:${getUploadIdentity(file)}`,
    onProgress,
  })

  const previousUploads = await upload.findPreviousUploads()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', abort)
      callback()
    }
    const abort = () => {
      void upload.abort(false).then(
        () => finish(() => reject(new DOMException('Upload pausado.', 'AbortError'))),
        (error: unknown) => finish(() => reject(error)),
      )
    }

    if (previousUploads.length > 0) {
      upload.resumeFromPreviousUpload(previousUploads[previousUploads.length - 1])
    }
    upload.options.onError = (error) => finish(() => reject(error))
    upload.options.onSuccess = () => finish(resolve)
    if (signal.aborted) {
      finish(() => reject(new DOMException('Upload pausado.', 'AbortError')))
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    upload.start()
  })
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

function formatTransferRate(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return '—'
  }
  return `${formatFileSize(bytesPerSecond)}/s`
}

function formatRemainingTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '—'
  }
  const remaining = Math.ceil(seconds)
  const hours = Math.floor(remaining / 3600)
  const minutes = Math.floor((remaining % 3600) / 60)
  const secs = remaining % 60
  if (hours > 0) return `${hours}h ${minutes}min`
  if (minutes > 0) return `${minutes}min ${secs}s`
  return `${secs}s`
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
  const [sortField, setSortField] = useState<'name' | 'updatedAt' | 'size'>('updatedAt')
  const [sortDescending, setSortDescending] = useState(true)
  const [folderPages, setFolderPages] = useState<Record<string, number>>({})
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginOpen, setLoginOpen] = useState(false)
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [sessionEmail, setSessionEmail] = useState('')
  const [sessionUserId, setSessionUserId] = useState('')
  const [accessRole, setAccessRole] = useState<AccessRole | null>(null)
  const [accessError, setAccessError] = useState('')
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([])
  const [managedUsersLoading, setManagedUsersLoading] = useState(false)
  const [managementError, setManagementError] = useState('')
  const [managementMessage, setManagementMessage] = useState('')
  const activeSessionUserIdRef = useRef('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteSubmitting, setInviteSubmitting] = useState(false)
  const [inviteSetupRequired, setInviteSetupRequired] = useState(
    () => new URLSearchParams(window.location.search).get('invite') === 'accepted',
  )
  const [invitePassword, setInvitePassword] = useState('')
  const [invitePasswordConfirm, setInvitePasswordConfirm] = useState('')
  const [inviteSetupMessage, setInviteSetupMessage] = useState('')
  const [inviteSetupSubmitting, setInviteSetupSubmitting] = useState(false)
  const [storageSnapshot, setStorageSnapshot] = useState<StorageSnapshot>(emptyStorageSnapshot)
  const [storageLoading, setStorageLoading] = useState(false)
  const [storageError, setStorageError] = useState('')
  const [storageActionMessage, setStorageActionMessage] = useState('')
  const [cacheMessage, setCacheMessage] = useState('')
  const [cachedFilePaths, setCachedFilePaths] = useState<Set<string>>(new Set())
  const [storageRefreshKey, setStorageRefreshKey] = useState(0)
  const [downloadingPath, setDownloadingPath] = useState('')
  const [deletingPath, setDeletingPath] = useState('')
  const [dialogFile, setDialogFile] = useState<StoredFile | null>(null)
  const [fileDialogText, setFileDialogText] = useState('')
  const [fileDialogPreviewUrl, setFileDialogPreviewUrl] = useState('')
  const [fileDialogLoading, setFileDialogLoading] = useState(false)
  const [fileDialogSaving, setFileDialogSaving] = useState(false)
  const [fileDialogError, setFileDialogError] = useState('')
  const [fileDialogPreviewKind, setFileDialogPreviewKind] = useState<PreviewKind>(null)
  const [pathEditFile, setPathEditFile] = useState<StoredFile | null>(null)
  const [pathEditValue, setPathEditValue] = useState('')
  const [pathEditError, setPathEditError] = useState('')
  const [pathEditSaving, setPathEditSaving] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [imagePreviews, setImagePreviews] = useState<{ path: string; url: string }[]>([])
  const previewGeneration = useRef(0)
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState('')
  const [uploadMessageTone, setUploadMessageTone] = useState<'info' | 'success' | 'error'>('info')
  const [uploadProgress, setUploadProgress] = useState({ completed: 0, total: 0 })
  const [uploadCurrentFileProgress, setUploadCurrentFileProgress] = useState(0)
  const [uploadBytes, setUploadBytes] = useState({ sent: 0, total: 0, speed: 0 })
  const [uploadComplete, setUploadComplete] = useState(false)
  const [uploadSuccessOpen, setUploadSuccessOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const refreshStorageRef = useRef<number | null>(null)
  const storageLoadingRef = useRef(false)
  const uploadInProgressRef = useRef(false)
  const uploadAbortControllerRef = useRef<AbortController | null>(null)
  const refreshPendingRef = useRef(false)
  const loadGenerationRef = useRef(0)
  const fileDialogGenerationRef = useRef(0)
  const isMaster = accessRole === 'master' || sessionEmail.toLocaleLowerCase() === masterEmail
  const canAccessAllFiles = isMaster || accessRole === 'manager'

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

  const userEmailById = useMemo(
    () => new Map(managedUsers.flatMap((user) => user.email ? [[user.id, user.email] as const] : [])),
    [managedUsers],
  )
  const filteredFiles = useMemo(() => storageSnapshot.files.filter((file) =>
    !search ||
    file.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()) ||
    (isMaster && (userEmailById.get(file.path.split('/')[0]) ?? '')
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase())),
  ).sort((left, right) => {
    let order = 0
    if (sortField === 'name') {
      order = left.name.localeCompare(right.name, 'pt-BR', { sensitivity: 'base' })
    } else if (sortField === 'size') {
      order = left.size - right.size
    } else {
      order = (left.updatedAt ?? '').localeCompare(right.updatedAt ?? '')
    }
    return sortDescending ? -order : order
  }), [isMaster, search, sortDescending, sortField, storageSnapshot.files, userEmailById])
  const displayStoragePath = (path: string) => {
    if (!canAccessAllFiles) {
      return path
    }

    const [ownerId, ...remainingPath] = path.split('/')
    const ownerEmail = userEmailById.get(ownerId)
    return ownerEmail ? [ownerEmail, ...remainingPath].join('/') : path
  }
  const displayStorageFolderPath = (path: string) => {
    if (!canAccessAllFiles) {
      return path
    }

    const [ownerId, ...remainingPath] = path.split('/')
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)
      ? remainingPath.join('/') || 'Arquivos na raiz'
      : path
  }
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
    const directFileFolders = new Set(storageSnapshot.files.map((file) =>
      file.path.slice(0, file.path.lastIndexOf('/')),
    ))
    const folders = storageSnapshot.folders.filter((folder) => {
      const isOwnerRoot = canAccessAllFiles &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(folder)
      return !isOwnerRoot || directFileFolders.has(folder)
    })
    if (folderFilesByPath.has('')) {
      folders.unshift('')
    }
    return folders
  }, [canAccessAllFiles, folderFilesByPath, storageSnapshot.files, storageSnapshot.folders])
  const totalStorageBytes = storageSnapshot.files.reduce((sum, file) => sum + file.size, 0)
  const recentFiles = useMemo(() => [...storageSnapshot.files]
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
    .slice(0, 4), [storageSnapshot.files])
  const uploadPercent = uploadProgress.total > 0
    ? uploadProgress.completed === uploadProgress.total
      ? 100
      : Math.min(99, Math.round((uploadProgress.completed + uploadCurrentFileProgress) / uploadProgress.total * 100))
    : 0

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!fileDialogPreviewUrl) {
      return
    }

    if (fileDialogPreviewUrl.startsWith('blob:')) {
      return () => URL.revokeObjectURL(fileDialogPreviewUrl)
    }
  }, [fileDialogPreviewUrl])

  useEffect(() => {
    if (!supabase) {
      return
    }

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        throw error
      }

      const nextSessionUserId = data.session?.user?.id ?? ''
      if (activeSessionUserIdRef.current !== nextSessionUserId) {
        activeSessionUserIdRef.current = nextSessionUserId
        setManagedUsers([])
        setManagedUsersLoading(false)
        setManagementError('')
        setManagementMessage('')
      }

      setSessionEmail(data.session?.user?.email ?? '')
      setEmail(data.session?.user?.email ?? '')
      setSessionUserId(nextSessionUserId)
      setAccessRole(null)
      setAccessError('')
      setStorageSnapshot(emptyStorageSnapshot)
      setStorageError('')
      setLastSyncedAt(null)
    }).catch((error: unknown) => {
      setStorageError(error instanceof Error ? error.message : 'Não foi possível verificar a sessão do Supabase.')
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextSessionUserId = session?.user?.id ?? ''
      if (activeSessionUserIdRef.current !== nextSessionUserId) {
        activeSessionUserIdRef.current = nextSessionUserId
        setManagedUsers([])
        setManagedUsersLoading(false)
        setManagementError('')
        setManagementMessage('')
      }

      setSessionEmail(session?.user?.email ?? '')
      setEmail(session?.user?.email ?? '')
      setSessionUserId(nextSessionUserId)
      setAccessRole(null)
      setAccessError('')
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
    let cancelled = false
    if (!supabaseClient || !sessionUserId) {
      return
    }

    const loadAccessRole = async () => {
      try {
        const { data, error } = await supabaseClient
          .from('user_profiles')
          .select('role')
          .eq('id', sessionUserId)
          .maybeSingle()
        if (error) {
          throw error
        }

        if (!cancelled) {
          setAccessRole(
            data?.role === 'master' || data?.role === 'manager'
              ? data.role
              : 'collaborator',
          )
          setAccessError('')
        }
      } catch (error) {
        if (!cancelled) {
          setAccessRole(null)
          setAccessError(error instanceof Error ? error.message : 'Não foi possível carregar o nível de acesso.')
        }
      }
    }

    void loadAccessRole()
    return () => {
      cancelled = true
    }
  }, [sessionUserId])

  useEffect(() => {
    const supabaseClient = supabase
    let cancelled = false
    if (!supabaseClient || !isMaster || !sessionUserId) {
      return
    }

    const loadManagedUsers = async () => {
      setManagedUsersLoading(true)
      setManagementError('')
      try {
        const { data, error } = await supabaseClient
          .from('user_profiles')
          .select('id, email, role, created_at')
          .order('created_at', { ascending: false })
        if (error) {
          throw error
        }
        if (!cancelled) {
          setManagedUsers((data ?? []).filter((user) =>
            user.role === 'master' || user.role === 'manager' || user.role === 'collaborator',
          ))
        }
      } catch (error) {
        if (!cancelled) {
          setManagementError(error instanceof Error ? error.message : 'Não foi possível carregar a lista de usuários.')
        }
      } finally {
        if (!cancelled) {
          setManagedUsersLoading(false)
        }
      }
    }

    void loadManagedUsers()

    return () => {
      cancelled = true
    }
  }, [isMaster, sessionUserId])

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
          const cachedSnapshot = cachedCatalog
            ? getCachedSupabaseSnapshot(cachedCatalog.snapshot)
            : null
          if (cachedCatalog && cachedSnapshot) {
            setStorageSnapshot(cachedSnapshot)
            setLastSyncedAt(cachedCatalog.savedAt)
          }
          const cachedObjectPaths = new Set(cachedSnapshot?.files.map((file) => file.objectPath) ?? [])
          setCachedFilePaths(new Set(cachedFiles
            .filter((cachedFile) => cachedObjectPaths.has(cachedFile.objectPath))
            .map((cachedFile) => cachedFile.objectPath)))
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
                const nestedStorageFolder = storageFolder
                  ? `${storageFolder}/${entry.name}`
                  : entry.name
                await readFolder(nestedStorageFolder, relativePath)
                continue
              }

              const ownerId = relativePath.split('/')[0]
              const ownerRelativePath = decodeStoragePath(relativePath.split('/').slice(1).join('/'))
              const originalPath = canAccessAllFiles
                ? `${ownerId}/${ownerRelativePath}`
                : ownerRelativePath
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

        let storageWarning = ''
        try {
          await readFolder(canAccessAllFiles ? '' : sessionUserId, '')
        } catch (error) {
          storageWarning = error instanceof Error
            ? `Não foi possível consultar os objetos do Supabase Storage: ${error.message}`
            : 'Não foi possível consultar os objetos do Supabase Storage.'
        }
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
          setStorageActionMessage(storageWarning)
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
  }, [canAccessAllFiles, sessionUserId, storageRefreshKey])

  const inviteCollaborator = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase || !isMaster) {
      setManagementError('Somente a conta Master pode convidar colaboradores.')
      return
    }

    setInviteSubmitting(true)
    setManagementError('')
    setManagementMessage('')

    try {
      const { data, error } = await supabase.functions.invoke<{ user: ManagedUser }>('manage-users', {
        body: {
          email: inviteEmail.trim(),
          redirectTo: `${appUrl}/?invite=accepted`,
        },
      })

      if (error) {
        const context = error.context
        if (context instanceof Response) {
          const responseBody: unknown = await context.clone().json().catch(() => null)
          if (
            typeof responseBody === 'object' &&
            responseBody !== null &&
            'error' in responseBody &&
            typeof responseBody.error === 'string'
          ) {
            throw new Error(responseBody.error)
          }
        }
        throw error
      }

      if (!data?.user) {
        throw new Error('O Supabase não confirmou o cadastro do colaborador.')
      }

      setManagedUsers((current) => [
        data.user,
        ...current.filter((user) => user.id !== data.user.id),
      ])
      setInviteEmail('')
      setManagementMessage(`Convite enviado para ${data.user.email ?? 'o endereço informado'}.`)
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : 'Não foi possível enviar o convite.')
    } finally {
      setInviteSubmitting(false)
    }
  }

  const changeManagedUserRole = async (userId: string, role: 'manager' | 'collaborator') => {
    if (!supabase || !isMaster) {
      setManagementError('Somente o Master pode alterar níveis de acesso.')
      return
    }

    setManagementError('')
    setManagementMessage('')
    try {
      const { data, error } = await supabase.functions.invoke<{ user: ManagedUser }>('manage-users', {
        body: { action: 'set_role', userId, role },
      })

      if (error) {
        const context = error.context
        if (context instanceof Response) {
          const responseBody: unknown = await context.clone().json().catch(() => null)
          if (
            typeof responseBody === 'object' &&
            responseBody !== null &&
            'error' in responseBody &&
            typeof responseBody.error === 'string'
          ) {
            throw new Error(responseBody.error)
          }
        }
        throw error
      }

      if (!data?.user) {
        throw new Error('O Supabase não confirmou a alteração do nível.')
      }
      setManagedUsers((users) => users.map((user) => user.id === data.user.id ? data.user : user))
      setManagementMessage(`Nível de ${data.user.email ?? 'usuário'} atualizado para ${role === 'manager' ? 'Gerente' : 'Colaborador'}.`)
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : 'Não foi possível alterar o nível de acesso.')
    }
  }

  const handleInvitePasswordSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase || !sessionUserId) {
      setInviteSetupMessage('Abra o link recebido por e-mail para continuar.')
      return
    }
    if (invitePassword.length < 8) {
      setInviteSetupMessage('A senha deve ter pelo menos 8 caracteres.')
      return
    }
    if (invitePassword !== invitePasswordConfirm) {
      setInviteSetupMessage('As senhas informadas não coincidem.')
      return
    }

    setInviteSetupSubmitting(true)
    setInviteSetupMessage('')
    try {
      const { error } = await supabase.auth.updateUser({ password: invitePassword })
      if (error) {
        throw error
      }

      setInviteSetupRequired(false)
      setInvitePassword('')
      setInvitePasswordConfirm('')
      setInviteSetupMessage('')
      window.history.replaceState({}, document.title, window.location.pathname)
      setAuthMessage('Senha definida. Sua conta de colaborador está pronta para uso.')
    } catch (error) {
      setInviteSetupMessage(error instanceof Error ? error.message : 'Não foi possível definir a senha.')
    } finally {
      setInviteSetupSubmitting(false)
    }
  }

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

  const openPathEditor = (file: StoredFile) => {
    setPathEditFile(file)
    setPathEditValue(canAccessAllFiles ? file.path.split('/').slice(1).join('/') : file.path)
    setPathEditError('')
  }

  const savePathEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!pathEditFile) {
      return
    }
    if (uploadInProgressRef.current || deletingPath) {
      setPathEditError('Aguarde a transferência ou exclusão atual terminar antes de alterar o caminho.')
      return
    }
    const requestedPath = pathEditValue.trim().replace(/\\/g, '/')
    if (
      !requestedPath ||
      requestedPath.length > 1024 ||
      requestedPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      setPathEditError('Informe um caminho relativo válido, sem segmentos vazios, "." ou "..".')
      return
    }
    setPathEditSaving(true)
    setPathEditError('')
    try {
      if (!supabase) {
        throw new Error('Configure o Supabase para mover arquivos.')
      }
      const ownerId = pathEditFile.objectPath.split('/')[0]
      const destinationPath = `${ownerId}/${getStoragePath(requestedPath)}`
      const { error } = await supabase.storage
        .from(storageBucket)
        .move(pathEditFile.objectPath, destinationPath)
      if (error) {
        throw error
      }
      try {
        await deleteCachedFile(sessionUserId, storageBucket, pathEditFile.objectPath)
      } catch (error) {
        setCacheMessage(`O arquivo foi movido, mas não foi possível invalidar a cópia local: ${error instanceof Error ? error.message : 'erro desconhecido.'}`)
      }
      setPathEditFile(null)
      triggerStorageRefresh()
    } catch (error) {
      setPathEditError(error instanceof Error ? error.message : 'Não foi possível atualizar o caminho.')
    } finally {
      setPathEditSaving(false)
    }
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

  const deleteStoredFiles = async (files: StoredFile[], label: string) => {
    if (!supabase || !sessionUserId || files.length === 0 || deletingPath) {
      return
    }
    if (uploadInProgressRef.current) {
      setStorageActionMessage('Aguarde a transferência atual terminar antes de excluir arquivos.')
      return
    }

    const uniqueFiles = [...new Map(files.map((file) => [file.objectPath, file])).values()]
    if (!window.confirm(`Excluir ${uniqueFiles.length} arquivo(s) de ${label} permanentemente do Storage? Esta ação não pode ser desfeita.`)) {
      return
    }

    setDeletingPath(label)
    setStorageActionMessage('')
    uploadInProgressRef.current = true
    try {
      const objectPaths = uniqueFiles.map((file) => file.objectPath)
      const storage = supabase.storage.from(storageBucket)
      for (let index = 0; index < objectPaths.length; index += 100) {
        const { error } = await storage.remove(objectPaths.slice(index, index + 100))
        if (error) {
          throw error
        }
      }

      setCachedFilePaths((paths) => {
        const next = new Set(paths)
        objectPaths.forEach((path) => next.delete(path))
        return next
      })
      const cacheResults = await Promise.allSettled(
        objectPaths.map((objectPath) => deleteCachedFile(sessionUserId, storageBucket, objectPath)),
      )
      const failedCacheDeletes = cacheResults.filter((result) => result.status === 'rejected').length
      setStorageActionMessage(`${uniqueFiles.length} arquivo(s) removido(s) do Storage.`)
      if (failedCacheDeletes > 0) {
        setCacheMessage(`Não foi possível remover ${failedCacheDeletes} cópia(s) do cache local; a próxima sincronização tentará corrigir o catálogo.`)
      }
      triggerStorageRefresh()
    } catch (error) {
      setStorageActionMessage(error instanceof Error ? `Não foi possível concluir a exclusão: ${error.message}` : 'Não foi possível concluir a exclusão.')
      triggerStorageRefresh()
    } finally {
      uploadInProgressRef.current = false
      setDeletingPath('')
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false
        triggerStorageRefresh()
      }
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
    if (deletingPath) {
      setFileDialogError('Aguarde a exclusão atual terminar antes de atualizar este arquivo.')
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
      if (!canAccessAllFiles && !file.objectPath.startsWith(`${session.user.id}/`)) {
        throw new Error('O arquivo não pertence à conta autenticada.')
      }

      const originalPath = canAccessAllFiles ? file.path.split('/').slice(1).join('/') : file.path
      if (replacement.size > 6 * 1024 * 1024) {
        await uploadSupabaseResumableFile(
          replacement,
          file.objectPath,
          originalPath,
          session.user.id,
          session.access_token,
          () => undefined,
          new AbortController().signal,
          true,
        )
      } else {
        const { error } = await supabase.storage.from(storageBucket).upload(file.objectPath, replacement, {
          cacheControl: '3600',
          upsert: true,
          contentType: replacement.type || file.contentType || 'application/octet-stream',
          metadata: { originalPath },
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
    if (deletingPath) {
      setUploadMessage('Aguarde a exclusão atual terminar antes de iniciar outro envio.')
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
    setUploadCurrentFileProgress(0)
    setUploadBytes({ sent: 0, total: selectedFiles.reduce((sum, file) => sum + file.size, 0), speed: 0 })
    const abortController = new AbortController()
    uploadAbortControllerRef.current = abortController
    let lastProgressAt = Date.now()
    let lastProgressBytes = 0
    let uploadedCount = 0
    let currentPath = ''
    let progressKey = ''
    let completed = new Set<string>()

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) {
        throw sessionError
      }

      if (!sessionData.session) {
        setUploadMessage('Faça login no app antes de enviar arquivos. O backend valida a sessão autenticada antes de iniciar o upload.')
        setUploadMessageTone('error')
        return
      }

      const userId = sessionData.session.user.id
      setSessionEmail(sessionData.session.user.email ?? '')
      progressKey = `meudrive:upload:${userId}:supabase:${getUploadJobId(selectedFiles)}`
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
      setUploadMessage('Verificando conflitos no Supabase Storage...')
      const storage = supabase.storage.from(storageBucket)
      const pageSize = 1000
      let storageConflictCheckWarning = ''
      const readStoragePage = async (storageFolder: string, offset: number) => {
        let entries: Awaited<ReturnType<typeof storage.list>>['data'] = null
        let lastError: unknown = null
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
            lastError = error
            break
          }
          lastError = error
          await new Promise((resolve) => window.setTimeout(resolve, 750 * (attempt + 1)))
        }

        if (entries === null) {
          storageConflictCheckWarning = `Não foi possível validar conflitos no Supabase Storage (${lastError instanceof Error ? lastError.message : 'erro desconhecido'}); a verificação de nomes pode estar incompleta.`
          return []
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
        const rootName = decodeStoragePath(path.split('/')[0])
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
          .map(({ path }) => decodeStoragePath(path)))
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
            decodeStoragePath(path) === rootName && completed.has(identity),
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
          messages.push(`Já existe uma pasta ou arquivo com o nome "${names}"${moreNames} em um dos armazenamentos.`)
        }
        if (repeatedPaths.size > 0) {
          messages.push(`O lote selecionado contém ${repeatedPaths.size} caminho(s) duplicado(s).`)
        }
        setUploadMessage(`${messages.join(' ')} Nenhum arquivo foi enviado. Altere o nome da pasta ou do arquivo e selecione novamente.`)
        setUploadMessageTone('error')
        return
      }

      uploadedCount = Math.min(completed.size, selectedFiles.length)
      setUploadProgress({ completed: uploadedCount, total: selectedFiles.length })
      let completedBytes = selectedFiles
        .filter((file) => completed.has(getUploadIdentity(file)))
        .reduce((sum, file) => sum + file.size, 0)

      for (const file of selectedFiles) {
        currentPath = getFilePath(file)
        setUploadCurrentFileProgress(0)
        const identity = getUploadIdentity(file)
        if (completed.has(identity)) {
          setUploadMessage(`Retomando envio: ${uploadedCount} de ${selectedFiles.length} arquivo(s) já concluídos.`)
          setUploadMessageTone('info')
          continue
        }

        setUploadMessage(`Enviando ${uploadedCount + 1} de ${selectedFiles.length}: ${currentPath}`)
        setUploadMessageTone('info')

        const reportProgress = (sentBytes: number, totalBytes: number) => {
          setUploadCurrentFileProgress(totalBytes > 0 ? Math.min(sentBytes / totalBytes, 1) : 1)
          const overallSent = completedBytes + sentBytes
          const now = Date.now()
          const elapsedSeconds = Math.max((now - lastProgressAt) / 1000, 0.001)
          const speed = Math.max(0, (overallSent - lastProgressBytes) / elapsedSeconds)
          lastProgressAt = now
          lastProgressBytes = overallSent
          setUploadBytes({
            sent: overallSent,
            total: selectedFiles.reduce((sum, selected) => sum + selected.size, 0),
            speed,
          })
        }

        const objectPath = `${userId}/${getStoragePath(currentPath)}`
        if (file.size === 0) {
          const { error } = await storage.upload(objectPath, file, {
            cacheControl: '3600',
            upsert: false,
            contentType: file.type || 'application/octet-stream',
            metadata: { originalPath: currentPath },
          })
          if (error) {
            throw error
          }
        } else {
          await uploadSupabaseResumableFile(
            file,
            objectPath,
            currentPath,
            userId,
            sessionData.session.access_token,
            reportProgress,
            abortController.signal,
            false,
          )
        }

        uploadedCount += 1
        completedBytes += file.size
        completed.add(identity)
        setUploadProgress({ completed: uploadedCount, total: selectedFiles.length })
        setUploadCurrentFileProgress(0)
        localStorage.setItem(progressKey, JSON.stringify({ completed: [...completed] }))
      }

      localStorage.removeItem(progressKey)
      setUploadComplete(true)
      setUploadCurrentFileProgress(0)
      setUploadMessage(`${uploadedCount} arquivo(s) enviado(s) para o Supabase Storage, mantendo a estrutura de pastas.`)
      setUploadMessageTone('success')
      if (storageConflictCheckWarning) {
        setStorageActionMessage(storageConflictCheckWarning)
      }
      setUploadSuccessOpen(true)
    } catch (error) {
      const message = getUploadErrorMessage(error)
      if (abortController.signal.aborted) {
        setUploadMessage(`Upload pausado após ${uploadedCount} de ${selectedFiles.length} arquivo(s). Selecione novamente o mesmo arquivo e clique em Enviar para retomar o envio no Supabase Storage.`)
        setUploadMessageTone('info')
        return
      }
      const normalizedMessage = message.toLowerCase()
      const details = normalizedMessage.includes('already exists') || normalizedMessage.includes('duplicate')
        ? `Já existe um objeto com esse nome. Nenhum arquivo existente foi substituído. Altere o nome da pasta ou do arquivo e tente novamente.`
        : normalizedMessage.includes('exceeded the maximum allowed size') || normalizedMessage.includes('maximum allowed size')
        ? `O arquivo ultrapassa o limite configurado do provedor de armazenamento.`
        : normalizedMessage.includes('row-level security')
        ? 'A sessão está autenticada, mas uma política RLS bloqueou a operação. Verifique as políticas de acesso do Supabase.'
        : message

      setUploadMessage(`Upload interrompido após ${uploadedCount} de ${selectedFiles.length} arquivo(s). Falha em "${currentPath}": ${details}`)
      setUploadMessageTone('error')
    } finally {
      uploadAbortControllerRef.current = null
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

  const acknowledgeUploadSuccess = () => {
    setUploadSuccessOpen(false)
    previewGeneration.current += 1
    setSelectedFiles([])
    setImagePreviews([])
    setUploadMessage('')
    setUploadMessageTone('info')
    setUploadProgress({ completed: 0, total: 0 })
    setUploadCurrentFileProgress(0)
    setUploadBytes({ sent: 0, total: 0, speed: 0 })
    setUploadComplete(false)
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
      setUploadCurrentFileProgress(0)
      setUploadBytes((current) => ({
        sent: current.sent,
        total: selectedFiles.concat(newFiles).reduce((sum, file) => sum + file.size, 0),
        speed: 0,
      }))
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
            {storageError ? 'Erro ao acessar os metadados' : storageLoading ? 'Atualizando dados da nuvem' : sessionUserId ? 'Conta conectada à nuvem' : 'Login necessário'}
          </p>
          <h2>Seu drive, sob controle.</h2>
          <p className="lead">
            Consulte, organize e transfira arquivos sem perder o contexto da nuvem.
          </p>
        </div>

        <div className="status-card">
          <div className="drive-orbit" aria-hidden="true">
            <span className="drive-core"><Cloud size={24} /></span>
            <span className="orbit-dot orbit-dot-one" />
            <span className="orbit-dot orbit-dot-two" />
          </div>
          <div>
            <span className="status-label">Armazenamento</span>
            <strong>Supabase</strong>
            <span className="status-meta">{sessionEmail || 'Entre para consultar seus arquivos'}</span>
          </div>
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
            <h3>Pastas no catálogo</h3>
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
                    <span className="status-pill">Na nuvem</span>
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
            <p>
              {uploadMessageTone === 'success'
                ? ''
                : uploadMessage || (uploadComplete ? 'Último envio concluído.' : 'A fila existe somente enquanto este app está aberto.')}
            </p>
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
              ? 'Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY para habilitar autenticação e metadados.'
              : !sessionUserId
                ? 'Entre com sua conta para consultar os objetos permitidos pelas políticas do Storage.'
                : 'Os metadados e arquivos são consultados no Supabase Storage.')}
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
          <span className="eyebrow">Arquivos na nuvem</span>
          <h4>{sessionUserId && !storageLoading && !storageError ? `${storageSnapshot.files.length.toLocaleString('pt-BR')} arquivos` : '—'}</h4>
          <p>{sessionUserId && !storageLoading && !storageError ? `${formatFileSize(totalStorageBytes)} armazenados no Supabase Storage` : storageError || 'Aguardando uma sessão válida.'}</p>
        </div>
        <div className="mini-card">
          <span className="eyebrow">Envio desta sessão</span>
          <h4>{uploading ? `${uploadPercent}%` : uploadComplete ? 'Concluído' : 'Inativo'}</h4>
          <p>
            {uploading
              ? `${uploadProgress.completed} de ${uploadProgress.total} arquivos concluídos`
              : uploadMessageTone === 'success' ? '' : uploadMessage || 'Nenhuma fila persistente está configurada.'}
          </p>
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
        <label className="muted">
          Ordenar por{' '}
          <select
            className="user-role-select"
            value={sortField}
            onChange={(event) => {
              const value = event.target.value
              if (value === 'name' || value === 'updatedAt' || value === 'size') {
                setSortField(value)
              }
            }}
          >
            <option value="updatedAt">Data</option>
            <option value="name">Nome</option>
            <option value="size">Tamanho</option>
          </select>
        </label>
        <Button type="button" variant="outline" size="sm" onClick={() => setSortDescending((descending) => !descending)}>
          {sortDescending ? 'Decrescente' : 'Crescente'}
        </Button>
        <Button type="button" size="sm" onClick={() => document.querySelector('.supabase-panel')?.scrollIntoView({ behavior: 'smooth' })}>
          <Upload size={14} aria-hidden="true" />
          Ir para envio
        </Button>
      </div>

      <p className="muted">Arquivos visíveis para {sessionEmail || 'a conta autenticada'}; o destino dos novos uploads pode ser escolhido na área de envio.</p>
      {storageError && <p className="status-message">{storageError}</p>}
      {storageActionMessage && <p className="status-message">{storageActionMessage}</p>}
      {cacheMessage && <p className="status-message">{cacheMessage}</p>}

      <div className="folder-dropdown-list">
        {explorerFolders.map((folder) => {
          const folderFiles = folderFilesByPath.get(folder) ?? []
          const folderFilesForDeletion = folder
            ? storageSnapshot.files.filter((file) => file.path.startsWith(`${folder}/`))
            : []
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
                <span className="folder-dropdown-name">{folder ? displayStorageFolderPath(folder) : 'Arquivos na raiz'}</span>
                <span className="badge neutral">{folderFiles.length} arquivo(s)</span>
                <ChevronDown className="folder-dropdown-chevron" size={16} aria-hidden="true" />
              </summary>
              <div className="folder-dropdown-content">
                {folderFilesForDeletion.length > 0 && (
                  <div className="folder-actions">
                    <span className="muted">
                      {folderFilesForDeletion.length} arquivo(s) nesta pasta e em suas subpastas.
                    </span>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => void deleteStoredFiles(folderFilesForDeletion, `a pasta "${displayStorageFolderPath(folder)}"`)}
                      disabled={Boolean(deletingPath)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      {deletingPath === `a pasta "${displayStorageFolderPath(folder)}"` ? 'Excluindo...' : 'Excluir pasta'}
                    </Button>
                  </div>
                )}
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
                              <div className="storage-file-cell" title={displayStoragePath(file.path)}>
                                <span className="storage-file-icon" aria-hidden="true">
                                  <FileTypeIcon size={18} strokeWidth={1.7} />
                                </span>
                                <button
                                  type="button"
                                  className="storage-file-name file-open-button"
                                  onClick={() => void openStoredFile(file)}
                                  aria-label={`Abrir ${displayStoragePath(file.path)}`}
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
                              <div className="file-action-buttons">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => openPathEditor(file)}
                                  disabled={Boolean(deletingPath)}
                                  aria-label={`Renomear ou mover ${displayStoragePath(file.path)}`}
                                >
                                  <Pencil size={14} aria-hidden="true" />
                                  Renomear/mover
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void downloadStoredFile(file)}
                                  disabled={downloadingPath === file.objectPath || Boolean(deletingPath)}
                                  aria-label={`Baixar ${displayStoragePath(file.path)}`}
                                >
                                  <Download size={14} aria-hidden="true" />
                                  {downloadingPath === file.objectPath
                                    ? 'Preparando...'
                                    : cachedFilePaths.has(file.objectPath)
                                      ? 'Baixar (local)'
                                      : 'Baixar'}
                                </Button>
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => void deleteStoredFiles([file], `o arquivo "${displayStoragePath(file.path)}"`)}
                                  disabled={Boolean(deletingPath)}
                                  aria-label={`Excluir ${displayStoragePath(file.path)}`}
                                >
                                  <Trash2 size={14} aria-hidden="true" />
                                  Excluir
                                </Button>
                              </div>
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
            <tr><td>Nível de acesso</td><td>{isMaster ? 'Master' : accessRole === 'manager' ? 'Gerente' : accessRole === 'collaborator' ? 'Colaborador' : 'Verificando…'}</td></tr>
            <tr><td>Bucket (Supabase Storage)</td><td>{storageBucket}</td></tr>
            <tr><td>Objetos acessíveis nesta sessão</td><td>{storageError ? 'Falha ao consultar' : storageLoading ? 'Consultando...' : storageSnapshot.files.length.toLocaleString('pt-BR')}</td></tr>
            <tr><td>Escopo</td><td>{canAccessAllFiles ? 'Todos os arquivos e pastas do bucket' : 'Somente os arquivos e pastas desta conta'}</td></tr>
          </tbody>
        </table>
      </div>
      {accessError && <p className="status-message" role="alert">Não foi possível carregar o perfil: {accessError}</p>}
      <p className="muted mt">
        O Supabase aplica políticas RLS e valida a propriedade dos objetos nas operações de armazenamento.
      </p>

      {isMaster && (
        <section className="user-management">
          <div className="panel-header">
            <div>
              <h3>Usuários e convites</h3>
              <p className="muted">Novas contas recebem o nível Colaborador. Somente Master altera os níveis.</p>
            </div>
            <span className="badge neutral">
              {managedUsersLoading ? 'Carregando...' : `${managedUsers.length} usuário(s)`}
            </span>
          </div>

          <form className="user-invite-form" onSubmit={(event) => void inviteCollaborator(event)}>
            <label className="user-invite-field">
              <span><Mail size={14} aria-hidden="true" /> E-mail do colaborador</span>
              <Input
                type="email"
                required
                autoComplete="email"
                placeholder="nome@empresa.com"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                disabled={inviteSubmitting}
              />
            </label>
            <Button type="submit" disabled={!inviteEmail.trim() || inviteSubmitting}>
              <UserPlus size={15} aria-hidden="true" />
              {inviteSubmitting ? 'Enviando convite...' : 'Convidar colaborador'}
            </Button>
          </form>

          {managementError && <p className="status-message error" role="alert">{managementError}</p>}
          {managementMessage && <p className="status-message success" role="status">{managementMessage}</p>}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Usuário</th>
                  <th>Nível</th>
                  <th>Adicionado em</th>
                </tr>
              </thead>
              <tbody>
                {managedUsers.map((user) => (
                  <tr key={user.id}>
                    <td>{user.email || 'E-mail não informado'}</td>
                    <td>
                      {user.role === 'master' ? (
                        'Master'
                      ) : (
                        <select
                          className="user-role-select"
                          aria-label={`Nível de ${user.email ?? 'usuário'}`}
                          value={user.role}
                          onChange={(event) => {
                            const value = event.target.value
                            if (value === 'manager' || value === 'collaborator') {
                              void changeManagedUserRole(user.id, value)
                            }
                          }}
                        >
                          <option value="collaborator">Colaborador</option>
                          <option value="manager">Gerente</option>
                        </select>
                      )}
                    </td>
                    <td>{formatModifiedDate(user.created_at)}</td>
                  </tr>
                ))}
                {!managedUsersLoading && managedUsers.length === 0 && (
                  <tr><td colSpan={3}>{managementError ? 'Não foi possível carregar os usuários.' : 'Nenhum usuário cadastrado.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  )

  const renderSettings = () => (
    <section className="panel">
      <div className="panel-header">
        <h3>Configuração do armazenamento</h3>
        <Button type="button" variant="outline" size="sm" onClick={refreshStorage} disabled={!sessionUserId || syncing}>
          <RefreshCw size={14} aria-hidden="true" className={syncing ? 'spin' : ''} />
          {syncing ? 'Sincronizando...' : 'Verificar conexão'}
        </Button>
      </div>

      <div className="settings-list">
        <div className="setting-row"><span>Configuração do Supabase</span><strong>{supabase ? 'Configurado' : 'Não configurado'}</strong></div>
        <div className="setting-row"><span>Bucket do Supabase Storage</span><strong>{storageBucket}</strong></div>
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
          <p><span className={`online-indicator ${sessionUserId ? '' : 'offline'}`} />{storageError ? 'Falha ao carregar arquivos' : storageLoading ? 'Carregando arquivos...' : sessionUserId ? `${storageSnapshot.files.length} arquivos na nuvem` : 'Faça login para sincronizar'}</p>
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
                {supabase
                  ? 'Novos arquivos serão enviados ao Supabase Storage.'
                  : 'Configure as chaves do projeto para ativar o armazenamento.'}
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
                <p className="upload-help">
                  Supabase Storage: upload retomável; se interrompido, selecione novamente o mesmo arquivo para continuar.
                  {' '}Pastas mantêm a estrutura de subpastas.
                </p>
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
                        setUploadCurrentFileProgress(0)
                        setUploadBytes({ sent: 0, total: 0, speed: 0 })
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
                <span><HardDrive size={14} aria-hidden="true" /> Supabase Storage</span>
              </div>

              <div className="toolbar">
                <Button type="button" size="sm" onClick={handleUpload} disabled={!supabase || selectedFiles.length === 0 || uploading || fileDialogSaving || Boolean(deletingPath)}>
                <Upload size={14} aria-hidden="true" />
                {uploading ? 'Enviando...' : !supabase ? 'Supabase não configurado' : `Enviar ${selectedFiles.length || ''} arquivo(s)`}
                </Button>
                {uploading && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => uploadAbortControllerRef.current?.abort()}
                  >
                    Pausar mantendo partes
                  </Button>
                )}
              </div>

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
              {uploadMessage && uploadMessageTone !== 'success' && (
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
              <div className="transfer-progress-copy">
                <span>{formatFileSize(uploadBytes.sent)} de {formatFileSize(uploadBytes.total)}</span>
                <strong>{formatTransferRate(uploadBytes.speed)} · {uploadBytes.speed > 0 ? formatRemainingTime((uploadBytes.total - uploadBytes.sent) / uploadBytes.speed) : '—'} restantes</strong>
              </div>
              <div
                className="transfer-progress-track"
                role="progressbar"
                aria-label="Progresso da transferência"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={uploadPercent}
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
      <Dialog.Root
        open={pathEditFile !== null}
        onOpenChange={(open) => {
          if (!open && !pathEditSaving) {
            setPathEditFile(null)
            setPathEditError('')
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="login-overlay" />
          <Dialog.Content className="login-dialog">
            <div className="login-dialog-header">
              <div className="login-dialog-icon"><Pencil size={18} aria-hidden="true" /></div>
              <div>
                <Dialog.Title className="login-dialog-title">Renomear ou mover arquivo</Dialog.Title>
                <Dialog.Description className="login-dialog-description">
                  Informe o novo caminho relativo. Para mover, inclua as pastas de destino.
                </Dialog.Description>
              </div>
            </div>
            <form className="login-form" onSubmit={(event) => void savePathEdit(event)}>
              <label>
                Nome e caminho
                <Input
                  autoFocus
                  required
                  maxLength={1024}
                  value={pathEditValue}
                  onChange={(event) => setPathEditValue(event.target.value)}
                  disabled={pathEditSaving}
                />
              </label>
              {pathEditError && <p className="status-message error" role="alert">{pathEditError}</p>}
              <div className="toolbar">
                <Button type="submit" disabled={pathEditSaving || !pathEditValue.trim()}>
                  {pathEditSaving ? 'Salvando...' : 'Salvar caminho'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPathEditFile(null)}
                  disabled={pathEditSaving}
                >
                  Cancelar
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={uploadSuccessOpen}
        onOpenChange={(open) => {
          if (open) {
            setUploadSuccessOpen(true)
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="login-overlay" />
          <Dialog.Content
            className="upload-success-dialog"
            onEscapeKeyDown={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => event.preventDefault()}
          >
            <div className="upload-success-header">
              <span className="upload-success-icon"><CheckCircle2 size={22} aria-hidden="true" /></span>
              <div>
                <Dialog.Title className="login-dialog-title">Upload concluído</Dialog.Title>
                <Dialog.Description className="upload-success-description">
                  {uploadProgress.completed.toLocaleString('pt-BR')} arquivo(s) enviado(s) com sucesso. Clique em OK para limpar a seleção e preparar um novo envio.
                </Dialog.Description>
              </div>
            </div>
            <div className="upload-success-actions">
              <Button type="button" onClick={acknowledgeUploadSuccess}>OK</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={inviteSetupRequired && Boolean(sessionUserId)}>
        <Dialog.Portal>
          <Dialog.Overlay className="login-overlay" />
          <Dialog.Content
            className="login-dialog"
            onEscapeKeyDown={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => event.preventDefault()}
          >
            <div className="login-dialog-header">
              <div className="login-dialog-icon"><KeyRound size={18} aria-hidden="true" /></div>
              <div>
                <Dialog.Title className="login-dialog-title">Defina sua senha</Dialog.Title>
                <Dialog.Description className="login-dialog-description">
                  Convite aceito para {sessionEmail}. Crie uma senha para acessar seus arquivos.
                </Dialog.Description>
              </div>
            </div>
            <form className="login-form" onSubmit={(event) => void handleInvitePasswordSetup(event)}>
              <label>
                Nova senha
                <Input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={invitePassword}
                  onChange={(event) => setInvitePassword(event.target.value)}
                  disabled={inviteSetupSubmitting}
                />
              </label>
              <label>
                Confirmar senha
                <Input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={invitePasswordConfirm}
                  onChange={(event) => setInvitePasswordConfirm(event.target.value)}
                  disabled={inviteSetupSubmitting}
                />
              </label>
              {inviteSetupMessage && <p className="status-message error" role="alert">{inviteSetupMessage}</p>}
              <Button type="submit" disabled={inviteSetupSubmitting}>
                <KeyRound size={15} aria-hidden="true" />
                {inviteSetupSubmitting ? 'Salvando senha...' : 'Salvar senha'}
              </Button>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

export default App
