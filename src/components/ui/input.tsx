import type { InputHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

function Input({ className, type, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type={type} className={cn('ui-input', className)} {...props} />
}

export { Input }
