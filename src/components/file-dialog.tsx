import * as Dialog from '@radix-ui/react-dialog'
import { Download, FileAudio, FileImage, FileVideo, Save, Upload, X } from 'lucide-react'
import { Button } from './ui/button'

type FileDialogFile = {
  name: string
  path: string
  size: number
  updatedAt: string | null
  contentType: string
}

type PreviewKind = 'image' | 'pdf' | 'audio' | 'video' | null

type FileDialogProps = {
  file: FileDialogFile | null
  text: string
  previewUrl: string
  previewKind: PreviewKind
  loading: boolean
  saving: boolean
  error: string
  statusMessage: string
  isEditable: boolean
  onOpenChange: (open: boolean) => void
  onTextChange: (text: string) => void
  onSave: () => void
  onReplace: (file: File) => void
  onDownload: () => void
}

function FileDialog({
  file,
  text,
  previewUrl,
  previewKind,
  loading,
  saving,
  error,
  statusMessage,
  isEditable,
  onOpenChange,
  onTextChange,
  onSave,
  onReplace,
  onDownload,
}: FileDialogProps) {
  return (
    <Dialog.Root open={file !== null} onOpenChange={(open) => {
      if (!saving) {
        onOpenChange(open)
      }
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="login-overlay" />
        <Dialog.Content className="file-dialog">
          <div className="login-dialog-header">
            <div className="login-dialog-icon">
              {previewKind === 'image' ? <FileImage size={18} aria-hidden="true" />
                : previewKind === 'audio' ? <FileAudio size={18} aria-hidden="true" />
                  : previewKind === 'video' ? <FileVideo size={18} aria-hidden="true" />
                    : <Upload size={18} aria-hidden="true" />}
            </div>
            <div className="file-dialog-heading">
              <Dialog.Title className="login-dialog-title">{file?.name ?? 'Arquivo'}</Dialog.Title>
              <Dialog.Description className="login-dialog-description">{file?.path ?? ''}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Fechar" disabled={saving}>
                <X size={17} aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>

          <div className="file-dialog-toolbar">
            <Button type="button" variant="outline" size="sm" onClick={onDownload} disabled={loading || saving}>
              <Download size={14} aria-hidden="true" />
              Baixar
            </Button>
            <label className="ghost-button small upload-picker-button">
              <Upload size={14} aria-hidden="true" />
              {saving ? 'Salvando...' : 'Substituir arquivo'}
              <input
                className="upload-input-hidden"
                type="file"
                disabled={saving}
                onChange={(event) => {
                  const replacement = event.target.files?.[0]
                  if (replacement) {
                    onReplace(replacement)
                  }
                  event.target.value = ''
                }}
              />
            </label>
            {isEditable && (
              <Button type="button" size="sm" onClick={onSave} disabled={loading || saving}>
                <Save size={14} aria-hidden="true" />
                {saving ? 'Salvando...' : 'Salvar alterações'}
              </Button>
            )}
          </div>

          {loading ? (
            <p className="file-dialog-message" role="status">Carregando arquivo...</p>
          ) : isEditable ? (
            <textarea
              className="file-editor"
              aria-label={`Conteúdo de ${file?.name ?? 'arquivo'}`}
              spellCheck={false}
              value={text}
              onChange={(event) => onTextChange(event.target.value)}
              disabled={saving}
            />
          ) : previewUrl && previewKind === 'image' ? (
            <div className="file-preview"><img src={previewUrl} alt={`Prévia de ${file?.name ?? 'arquivo'}`} /></div>
          ) : previewUrl && previewKind === 'pdf' ? (
            <iframe className="file-preview-frame" src={previewUrl} title={`Prévia de ${file?.name ?? 'arquivo'}`} />
          ) : previewUrl && previewKind === 'audio' ? (
            <div className="file-preview file-preview-media"><audio controls src={previewUrl}>Seu navegador não suporta áudio.</audio></div>
          ) : previewUrl && previewKind === 'video' ? (
            <div className="file-preview file-preview-media"><video controls src={previewUrl}>Seu navegador não suporta vídeo.</video></div>
          ) : (
            <p className="file-dialog-message">Não há pré-visualização disponível para este formato. Você pode baixar o arquivo ou selecionar uma versão revisada para substituí-lo.</p>
          )}

          {statusMessage && <p className="status-message" role="status">{statusMessage}</p>}
          {error && <p className="status-message" role="alert">{error}</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { FileDialog }
export type { PreviewKind }
