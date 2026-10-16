import * as Menu from '@radix-ui/react-context-menu'
import type { ReactElement } from 'react'
import type { Session } from '../../sessions/workspace'

export type CloseTabsAction = 'one' | 'others' | 'right' | 'saved' | 'all'
export function TabMenu({ session, files, busy, onClose, children }: { session: Session; files: Session[]; busy: boolean; onClose: (action: CloseTabsAction, session: Session) => void; children: ReactElement }) {
  const index = files.indexOf(session)
  const saved = files.some((file) => !file.dirty && file.state === 'saved' && !file.pendingUploads && !file.locked)
  return <Menu.Root modal={false}><Menu.Trigger asChild disabled={busy}>{children}</Menu.Trigger><Menu.Portal><Menu.Content className="context-menu tab-context-menu" aria-label="标签页操作" onCloseAutoFocus={(event) => {
    event.preventDefault()
    requestAnimationFrame(() => (document.querySelector<HTMLButtonElement>('.tabs [role="tab"][aria-selected="true"]') ?? document.getElementById('explorer-toggle'))?.focus())
  }}>
    <Menu.Item disabled={busy} onSelect={() => onClose('one', session)}>关闭</Menu.Item>
    <Menu.Item disabled={busy || files.length < 2} onSelect={() => onClose('others', session)}>关闭其他</Menu.Item>
    <Menu.Item disabled={busy || index === files.length - 1} onSelect={() => onClose('right', session)}>关闭右侧标签页</Menu.Item>
    <Menu.Separator />
    <Menu.Item disabled={busy || !saved} onSelect={() => onClose('saved', session)}>关闭已保存</Menu.Item>
    <Menu.Item disabled={busy} onSelect={() => onClose('all', session)}>关闭所有</Menu.Item>
  </Menu.Content></Menu.Portal></Menu.Root>
}
