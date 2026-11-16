import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline'
}

function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return <span className={cn('ui-badge', `ui-badge-${variant}`, className)} {...props} />
}

export { Badge }
