import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { workspace } from '../../sessions/current'
import { reconcileSession } from '../../sessions/reconcile'
import { api } from '../../services/api'
import { RemoteNotices } from '../../sessions/remote-notices'
import { ApiError } from '../../services/api'

export function useExternalChanges(workspaceId: string) {
  const client = useQueryClient()
  const running = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const requestCheck = useRef<(paths?: string[]) => void>(() => {})
  const [warning, setWarning] = useState('')
  const [streamWarning, setStreamWarning] = useState('')
  const [checking, setChecking] = useState(false)
  const [notices] = useState(() => new RemoteNotices(workspace))
  const check = useCallback(() => { requestCheck.current() }, [])
  useEffect(() => {
    let disposed = false, full = false
    const paths = new Set<string>()
    const sources = new Map<string, string>()
    let debounce: ReturnType<typeof setTimeout> | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const drain = async () => {
      if (disposed || running.current || document.visibilityState === 'hidden') return
      running.current = true; setChecking(true)
      const abort = new AbortController(); controller.current = abort
      let failed = false
      try {
        while (!disposed && (full || paths.size)) {
          const all = full, affected = [...paths], origins = new Map(sources); full = false; paths.clear(); sources.clear()
          notices.prune()
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])
          void client.invalidateQueries({ queryKey: ['tree'] })
          void client.invalidateQueries({ queryKey: ['trash'] })
          let busy = false
          for (const session of workspace.list()) {
            if (!all && !affected.some(path => session.path === path || session.path.startsWith(`${path}/`))) continue
            if (signal.aborted) { failed = true; break }
            if (session.locked || session.pendingUploads || session.state === 'saving') { busy = true; continue }
            const checkedPath = session.path, generation = session.generation, revision = session.revision
            try {
              if (['markdown', 'text'].includes(session.viewer)) await notices.check(session, signal, origins.get(session.path))
              else await reconcileSession(workspace, session, signal, true)
            }
            catch (error) {
              if (disposed || signal.aborted || !workspace.has(checkedPath) || workspace.get(checkedPath) !== session || session.generation !== generation || session.revision !== revision) continue
              const pending = notices.list().find(entry => entry.path === checkedPath)
              if (pending) notices.wait(pending)
              if (error instanceof ApiError && [404, 413, 415].includes(error.status)) workspace.markExternal(checkedPath, error.status === 404 ? 'missing' : 'changed')
              else failed = true
            }
          }
          if (signal.aborted) failed = true
          if (busy && !disposed) {
            if (retry) clearTimeout(retry)
            retry = setTimeout(() => enqueue(all ? undefined : affected), 250)
          }
        }
        if (!disposed) setWarning(failed ? '部分文件的更新核对失败，当前正文已保留，请重试。' : '')
      } finally { running.current = false; if (!disposed) setChecking(false) }
    }
    const enqueue = (changed?: string[]) => {
      if (disposed) return
      if (!changed?.length || changed.length > 256) full = true
      else for (const path of changed) paths.add(path)
      if (paths.size > 256) { paths.clear(); full = true }
      if (!debounce) debounce = setTimeout(() => { debounce = undefined; void drain() }, 50)
    }
    requestCheck.current = enqueue
    let source: EventSource | undefined
    const connect = () => {
      if (disposed || source) return
      try {
        const stream = new EventSource(`/api/v1/workspace/events?workspace=${encodeURIComponent(workspaceId)}`)
        source = stream
        stream.onopen = () => { if (!disposed && source === stream) setStreamWarning('') }
        stream.onerror = () => { if (!disposed && source === stream) setStreamWarning('实时通知已断开，正在重连；暂以 10 秒版本检查同步更新。') }
        stream.addEventListener('resync', () => { if (source === stream) enqueue() })
        stream.addEventListener('change', event => {
          if (disposed || source !== stream) return
          try {
            const change = JSON.parse((event as MessageEvent).data)
            if (change.reset) enqueue()
            else if (Array.isArray(change.paths) && change.paths.every((path: unknown) => typeof path === 'string')) {
              for (const path of change.paths) {
                if (typeof change.source?.name === 'string') sources.set(path, change.source.name)
                else sources.delete(path)
              }
              enqueue(change.paths)
            }
            else throw new Error('通知格式无效')
          } catch { setStreamWarning('实时通知格式无效，已重新核对文件。'); enqueue() }
        })
        stream.addEventListener('auth', () => { if (source === stream) { void api.me().catch(() => {}); enqueue() } })
      } catch { queueMicrotask(() => { if (!disposed) setStreamWarning('无法连接实时通知，暂以 10 秒版本检查同步更新。') }) }
    }
    const offline = () => { source?.close(); source = undefined; setStreamWarning('网络已离线，实时通知暂停；恢复连接后会重新核对。') }
    const online = () => { connect(); enqueue() }
    connect()
    window.addEventListener('offline', offline); window.addEventListener('online', online)
    const timer = setInterval(() => enqueue(), 10_000)
    const focus = () => enqueue()
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus)
    return () => {
      disposed = true; source?.close(); clearInterval(timer)
      if (debounce) clearTimeout(debounce); if (retry) clearTimeout(retry)
      window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus)
      window.removeEventListener('offline', offline); window.removeEventListener('online', online)
      controller.current?.abort(); requestCheck.current = () => {}
    }
  }, [client, workspaceId, notices])
  return { check, warning: warning || streamWarning, checking, notices }
}
