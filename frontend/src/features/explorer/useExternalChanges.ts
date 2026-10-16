import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { workspace } from '../../sessions/current'
import { reconcileSession } from '../../sessions/reconcile'

export function useExternalChanges() {
  const client = useQueryClient()
  const running = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const [warning, setWarning] = useState('')
  const [checking, setChecking] = useState(false)
  const check = useCallback(async () => {
    if (running.current || document.visibilityState === 'hidden') return
    running.current = true; setChecking(true)
    const abort = new AbortController(); controller.current = abort
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])
    let failed = false
    try {
      void client.invalidateQueries({ queryKey: ['tree'] })
      // 顺序扫描，避免标签页很多时同时读取大量文件或挤占保存请求。
      for (const session of workspace.list()) {
        if (signal.aborted) { failed = true; break }
        try { await reconcileSession(workspace, session, signal) }
        catch { failed = true }
      }
      if (signal.aborted) failed = true
      if (!abort.signal.aborted) setWarning(failed ? '部分文件的磁盘变更检查失败，当前正文已保留，请重试。' : '')
    } finally { running.current = false; if (!abort.signal.aborted) setChecking(false) }
  }, [client])
  useEffect(() => {
    const timer = setInterval(() => void check(), 10_000)
    const focus = () => void check()
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus)
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); controller.current?.abort() }
  }, [check])
  return { check, warning, checking }
}
