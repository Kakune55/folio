import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, Info, LoaderCircle, X } from 'lucide-react'
import { notify, type Notification } from '../../stores/notifications'
import { Button } from './button'

const NotificationContext = createContext<{ register: (element: HTMLElement) => () => void; remoteSlot: HTMLDivElement | null } | null>(null)

// 模态内注册同一个通知层，保留 Radix 的焦点约束与辅助技术可见性。
export function NotificationMount() {
  const element = useRef<HTMLDivElement>(null)
  const register = useContext(NotificationContext)?.register
  useLayoutEffect(() => { if (element.current && register) return register(element.current) }, [register])
  return <div ref={element} className="notification-mount" />
}

export function NotificationPortal({ children }: { children: ReactNode }) {
  const slot = useContext(NotificationContext)?.remoteSlot
  return slot ? createPortal(children, slot) : null
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [targets, setTargets] = useState<HTMLElement[]>([])
  const [remoteSlot, setRemoteSlot] = useState<HTMLDivElement | null>(null)
  const register = useCallback((element: HTMLElement) => {
    setTargets((previous) => [...previous, element])
    return () => setTargets((previous) => previous.filter((target) => target !== element))
  }, [])
  return <NotificationContext value={{ register, remoteSlot: targets.length ? null : remoteSlot }}>{children}{createPortal(<NotificationViewport onRemoteSlot={setRemoteSlot} />, targets.at(-1) ?? document.body)}</NotificationContext>
}

function NotificationViewport({ onRemoteSlot }: { onRemoteSlot: (element: HTMLDivElement | null) => void }) {
  const entries = useSyncExternalStore(notify.subscribe, notify.snapshot)
  const root = useRef<HTMLDivElement>(null)
  const [paused] = useState(() => new Set<string>())
  useLayoutEffect(() => {
    // 原生顶层避免被弹窗的 transform / overflow 裁切，不改变焦点。
    root.current?.showPopover()
  }, [])
  useEffect(() => {
    let previous = performance.now()
    const advance = () => {
      const now = performance.now()
      if (!document.hidden) notify.advance(now - previous, paused)
      previous = now
    }
    const visibility = () => { previous = performance.now() }
    const timer = window.setInterval(advance, 100)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('folio:unauthenticated', notify.clear)
    window.addEventListener('folio:workspace-changed', notify.clear)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('folio:unauthenticated', notify.clear)
      window.removeEventListener('folio:workspace-changed', notify.clear)
    }
  }, [paused])
  return <div ref={root} popover="manual" className="notification-stack" role="region" aria-label="通知" onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }}>
    <div ref={onRemoteSlot} className="notification-remote-slot" />
    {entries.slice(0, 3).map((entry) => <NotificationCard key={entry.id} entry={entry} paused={paused} />)}
    {entries.length > 3 && <Button className="notification-more" onClick={notify.next}>还有 {entries.length - 3} 条通知，点击查看</Button>}
  </div>
}

function NotificationCard({ entry, paused }: { entry: Notification; paused: Set<string> }) {
  const hovered = useRef(false), focused = useRef(false)
  const Icon = { success: CheckCircle2, info: Info, error: CircleAlert, loading: LoaderCircle }[entry.kind]
  const actionLock = useRef(false)
  const [busy, setBusy] = useState(false)
  const onPause = (value: boolean) => { if (value) paused.add(entry.id); else paused.delete(entry.id) }
  useEffect(() => () => { paused.delete(entry.id) }, [entry.id, paused])
  const progress = entry.progress === undefined ? undefined : Math.min(100, Math.max(0, entry.progress))
  return <article className={`notification-card notification-${entry.kind}`} aria-label="操作通知"
    onMouseEnter={() => { hovered.current = true; onPause(true) }} onMouseLeave={() => { hovered.current = false; onPause(focused.current) }}
    onFocusCapture={() => { focused.current = true; onPause(true) }} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { focused.current = false; onPause(hovered.current) } }}>
    <Icon className="notification-icon" size={18} aria-hidden="true" />
    <div className="notification-content"><div role={entry.kind === 'error' ? 'alert' : 'status'} aria-atomic="true"><strong>{entry.message}</strong>{entry.description && <p>{entry.description}</p>}</div>
      {entry.action && <Button disabled={busy} onClick={async () => {
        if (actionLock.current) return
        actionLock.current = true; setBusy(true)
        try { await entry.action!.onClick(); notify.dismiss(entry.id) }
        catch (error) { notify.error(error instanceof Error ? error.message : '操作失败，请重试', { id: entry.id, action: entry.action }) }
        finally { actionLock.current = false; setBusy(false) }
      }}>{busy ? '正在处理…' : entry.action.label}</Button>}
      {entry.kind === 'loading' && progress !== undefined && <small>{Math.round(progress)}%</small>}
    </div>
    <Button size="icon" aria-label="关闭通知" disabled={busy} onClick={() => notify.dismiss(entry.id)}><X size={15} /></Button>
    {entry.kind === 'loading' ? progress !== undefined && <div className="notification-progress" role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{ width: `${progress}%` }} /></div> : entry.duration > 0 && <div className="notification-progress notification-countdown" aria-hidden="true"><span style={{ width: `${entry.remaining / entry.duration * 100}%` }} /></div>}
  </article>
}
