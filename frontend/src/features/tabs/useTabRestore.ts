import { useEffect, useState } from 'react'
import { api } from '../../services/api'
import { workspace } from '../../sessions/current'
import { useUI } from '../../stores/ui'

type SavedTabs = { version: 1; paths: string[]; activePath: string }
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\\') && ![...value].some(char => char.charCodeAt(0) < 32) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')

export function parseTabs(raw: string | null): SavedTabs {
  if (raw === null) return { version: 1, paths: [], activePath: '' }
  const value = JSON.parse(raw)
  if (value?.version !== 1 || !Array.isArray(value.paths) || !value.paths.every(validPath) || new Set(value.paths).size !== value.paths.length || typeof value.activePath !== 'string' || (value.activePath !== '' && !value.paths.includes(value.activePath))) throw new Error('标签记录格式无效')
  return { version: 1, paths: value.paths, activePath: value.activePath }
}

export function useTabRestore(workspaceId: string, userId: number) {
  const [warning, setWarning] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [forget, setForget] = useState(false)
  useEffect(() => {
    const key = `folio.tabs.v1:${userId}:${workspaceId}`
    const controller = new AbortController()
    let cancelled = false, ready = false, failed: string[] = [], lastSaved = ''
    let saved: SavedTabs
    let interacted = false
    const persist = () => {
      if (!ready || cancelled) return
      // 手动打开成功后即解除待恢复标记，之后关闭不能让旧失败路径复活。
      failed = failed.filter(path => !workspace.has(path))
      const paths = [...workspace.list().map(session => session.path), ...failed]
      const active = useUI.getState().activePath
      const value = JSON.stringify({ version: 1, paths, activePath: paths.includes(active) ? active : '' })
      if (value === lastSaved) return
      try { localStorage.setItem(key, value); lastSaved = value }
      catch { setWarning('无法保存本机标签记录。请允许浏览器存储后重试；当前文件和草稿不受影响。') }
    }
    const unsubscribeWorkspace = workspace.subscribe(persist)
    const unsubscribeUI = useUI.subscribe((state, previous) => {
      if (state.activePath !== previous.activePath) { interacted = true; persist() }
    })
    const restore = async () => {
      setWarning('')
      try { saved = forget ? { version: 1, paths: [], activePath: '' } : parseTabs(localStorage.getItem(key)) }
      catch { setWarning('无法读取本机标签记录。可以重试，或仅记住当前标签以重置记录；浏览器恢复稿不受影响。'); return }
      const errors: string[] = []
      for (const path of saved.paths) {
        if (cancelled) return
        if (workspace.has(path)) continue
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
          const metadata = await api.metadata(path, signal)
          if (cancelled) return
          const file = ['markdown', 'text'].includes(metadata.viewer) ? await api.read(path, signal) : undefined
          if (cancelled) return
          // 用户已经打开或恢复的会话优先，绝不替换其正文或版本。
          if (!workspace.has(path)) workspace.add({ path, source: file?.content ?? '', revision: file?.revision ?? '', viewer: metadata.viewer, metadata, mode: metadata.viewer === 'markdown' ? 'rich' : 'source' })
        } catch (error) {
          if (cancelled) return
          failed.push(path)
          errors.push(`「${path}」：${error instanceof Error ? error.message : '读取失败'}`)
        }
      }
      if (cancelled) return
      if (!interacted) {
        const active = workspace.has(saved.activePath) ? saved.activePath : workspace.list()[0]?.path ?? ''
        useUI.getState().open(active)
      }
      ready = true
      if (errors.length) setWarning(`部分标签未恢复，记录仍保留。${errors.join('；')}`)
      persist()
    }
    void restore()
    return () => { cancelled = true; controller.abort(); unsubscribeWorkspace(); unsubscribeUI() }
  }, [workspaceId, userId, attempt, forget])
  return { warning, retry: () => { setForget(false); setAttempt(value => value + 1) }, reset: () => { setForget(true); setAttempt(value => value + 1) } }
}
