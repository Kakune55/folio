export type NotificationKind = 'success' | 'info' | 'error' | 'loading'
export type NotificationOptions = {
  id?: string
  description?: string
  duration?: number
  progress?: number
  action?: { label: string; onClick: () => void | Promise<void> }
}
export type Notification = NotificationOptions & { id: string; kind: NotificationKind; message: string; duration: number; remaining: number }

// 仅保存界面反馈，不持久化正文、令牌或恢复数据。排队中的通知不消耗展示时间。
export function createNotificationStore() {
  let entries: Notification[] = []
  let sequence = 0
  let generation = 0
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((listener) => listener())
  const dismiss = (id: string) => { entries = entries.filter((entry) => entry.id !== id); emit() }
  const push = (kind: NotificationKind, message: string, options: NotificationOptions = {}) => {
    const id = options.id ?? (kind === 'loading' ? undefined : entries.find((entry) => entry.kind === kind && entry.message === message)?.id) ?? `notification-${generation}-${++sequence}`
    if (/^notification-\d+-\d+$/.test(id) && Number(id.split('-')[1]) !== generation) return id
    const duration = kind === 'error' || kind === 'loading' || options.action ? 0 : Math.max(0, options.duration ?? 4000)
    const entry: Notification = { ...options, id, kind, message, duration, remaining: duration }
    const index = entries.findIndex((entry) => entry.id === id)
    entries = index < 0 ? [...entries, entry] : entries.map((old) => old.id === id ? entry : old)
    emit()
    return id
  }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => entries,
    success: (message: string, options?: NotificationOptions) => push('success', message, options),
    info: (message: string, options?: NotificationOptions) => push('info', message, options),
    error: (message: string, options?: NotificationOptions) => push('error', message, options),
    loading: (message: string, options?: NotificationOptions) => push('loading', message, options),
    update: (id: string, changes: Pick<NotificationOptions, 'description' | 'progress'> & { message?: string }) => {
      entries = entries.map((entry) => entry.id === id ? { ...entry, ...changes } : entry)
      emit()
    },
    dismiss,
    clear: () => { generation++; entries = []; emit() },
    next: () => { entries = [...entries.slice(3), ...entries.slice(0, 3)]; emit() },
    advance: (elapsed: number, paused: ReadonlySet<string>) => {
      if (!entries.some((entry, index) => index < 3 && entry.duration > 0 && !paused.has(entry.id))) return
      entries = entries.map((entry, index) => index >= 3 || !entry.duration || paused.has(entry.id) ? entry : { ...entry, remaining: Math.max(0, entry.remaining - Math.max(0, elapsed)) }).filter((entry) => !entry.duration || entry.remaining > 0)
      emit()
    },
  }
}

export const notify = createNotificationStore()
