import type { ButtonHTMLAttributes } from 'react'
import { cva } from 'class-variance-authority'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

const buttonVariants = cva('button', {
  variants: { variant: { ghost: 'button-ghost', outline: 'button-outline' }, size: { default: '', icon: 'button-icon' } },
  defaultVariants: { variant: 'ghost', size: 'default' },
})
export function Button({ className, variant, size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'ghost' | 'outline'; size?: 'default' | 'icon'
}) {
  return <button className={twMerge(clsx(buttonVariants({ variant, size }), className))} {...props} />
}
