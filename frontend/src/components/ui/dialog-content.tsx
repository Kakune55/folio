import { useRef } from 'react'
import type { ComponentProps } from 'react'
import * as Dialog from '@radix-ui/react-dialog'

// 部分窗口由快捷键/文件菜单打开，没有 Radix Trigger；显式保留并恢复原焦点。
function previousFocusTarget() {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const ids = active?.closest('[role="menu"]')?.getAttribute('aria-labelledby')?.split(/\s+/) ?? []
  for (const id of ids) {
    const trigger = document.getElementById(id)
    if (trigger instanceof HTMLElement && trigger.getAttribute('aria-haspopup') === 'menu') return trigger
  }
  return active
}

export function DialogContent({ onOpenAutoFocus, onCloseAutoFocus, ...props }: ComponentProps<typeof Dialog.Content>) {
  // 在子输入框的 React autoFocus 生效前捕获；Scope 的打开回调可能已经太晚。
  const previous = useRef<HTMLElement | null>(previousFocusTarget())
  return <Dialog.Content {...props} onOpenAutoFocus={(event) => {
    onOpenAutoFocus?.(event)
  }} onCloseAutoFocus={(event) => {
    onCloseAutoFocus?.(event)
    if (event.defaultPrevented) return
    event.preventDefault()
    const target = previous.current
    if (target && target !== document.body && target.isConnected && !target.matches(':disabled') && !target.closest('[inert]')) target.focus({ preventScroll: true })
    else document.getElementById('explorer-toggle')?.focus({ preventScroll: true })
  }} />
}
