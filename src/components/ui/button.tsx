import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

const buttonVariants = cva('ui-button', {
  variants: {
    variant: {
      default: 'ui-button-default',
      destructive: 'ui-button-destructive',
      outline: 'ui-button-outline',
      secondary: 'ui-button-secondary',
      ghost: 'ui-button-ghost',
      link: 'ui-button-link',
    },
    size: {
      default: 'ui-button-default-size',
      sm: 'ui-button-sm',
      lg: 'ui-button-lg',
      icon: 'ui-button-icon',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
})

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button'

  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { Button }
