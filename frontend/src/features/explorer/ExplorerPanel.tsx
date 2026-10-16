import { DialogContent } from '../../components/ui/dialog-content'
import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'

export function ExplorerPanel({ mobile, open, onOpenChange, children }: { mobile: boolean; open: boolean; onOpenChange: (value: boolean) => void; children: ReactNode }) {
  if (!mobile) return <aside className="explorer" aria-label="文件资源管理器" inert={!open}>{children}</aside>
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay explorer-overlay" /><DialogContent className="explorer explorer-drawer" onCloseAutoFocus={(event) => {
    event.preventDefault()
    // 抽屉让位给新建/搜索等窗口时，新窗口已接管焦点，不能抢回开关。
    if (document.querySelector('[role="dialog"]:not(.explorer-drawer)')) return
    // 选中文档后不弹出软键盘；焦点回到始终可见的抽屉开关。
    document.getElementById('explorer-toggle')?.focus({ preventScroll: true })
  }}><Dialog.Title className="visually-hidden">文件列表</Dialog.Title><Dialog.Description className="visually-hidden">浏览目录并选择文件。选中文件后返回正文，也可关闭文件列表。</Dialog.Description>{children}</DialogContent></Dialog.Portal></Dialog.Root>
}
