import * as Dialog from '@radix-ui/react-dialog'
import { LockKeyhole, LogIn, UserRound, X } from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'

type LoginDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  email: string
  password: string
  sessionEmail: string
  message: string
  isSubmitting: boolean
  isConfigured: boolean
  onEmailChange: (email: string) => void
  onPasswordChange: (password: string) => void
  onSubmit: () => void
  onSignOut: () => void
}

function LoginDialog({
  open,
  onOpenChange,
  email,
  password,
  sessionEmail,
  message,
  isSubmitting,
  isConfigured,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  onSignOut,
}: LoginDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="login-overlay" />
        <Dialog.Content className="login-dialog">
          <div className="login-dialog-header">
            <div className="login-dialog-icon"><LockKeyhole size={18} aria-hidden="true" /></div>
            <div>
              <Dialog.Title className="login-dialog-title">
                {sessionEmail ? 'Sua conta' : 'Entrar no MeuDrive'}
              </Dialog.Title>
              <Dialog.Description className="login-dialog-description">
                {sessionEmail ? 'Sessão autenticada no armazenamento.' : 'Use suas credenciais para acessar os arquivos da equipe.'}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Fechar">
                <X size={17} aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>

          {sessionEmail ? (
            <div className="account-session">
              <Badge variant="secondary"><UserRound size={13} aria-hidden="true" /> {sessionEmail}</Badge>
              <Button type="button" variant="outline" onClick={onSignOut}>Sair da conta</Button>
            </div>
          ) : (
            <form
              className="login-form"
              onSubmit={(event) => {
                event.preventDefault()
                onSubmit()
              }}
            >
              <label>
                E-mail
                <Input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => onEmailChange(event.target.value)}
                />
              </label>
              <label>
                Senha
                <Input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => onPasswordChange(event.target.value)}
                />
              </label>
              {!isConfigured && <p className="status-message">Configure as variáveis do Supabase para habilitar o login.</p>}
              {message && <p className="status-message" role="status">{message}</p>}
              <Button type="submit" disabled={!isConfigured || isSubmitting}>
                <LogIn size={15} aria-hidden="true" />
                {isSubmitting ? 'Entrando...' : 'Entrar'}
              </Button>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { LoginDialog }
