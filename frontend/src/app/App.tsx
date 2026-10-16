import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, setCSRF, pinWorkspace, downloadDraft } from '../services/api'
import type { Principal } from '../services/api'
import { Login } from '../features/auth/Login'
import { useTheme } from './useTheme'
import { workspace } from '../sessions/current'
const Workbench = lazy(() => import('./Workbench'))
const Spike = import.meta.env.DEV ? lazy(() => import('./Spike')) : null

export default function App() {
  useTheme()
  const client = useQueryClient()
  const [expired, setExpired] = useState(false)
  const [workspaceID, setWorkspaceID] = useState('')
  const [workspaceChanged, setWorkspaceChanged] = useState(false)
  const bindPrincipal = useCallback((value: Principal) => {
    const id = value.workspaceId
    if (!id || !/^[a-f0-9]{64}$/.test(id)) return value
    if (workspaceID && workspaceID !== id) { workspace.suspend(); setWorkspaceChanged(true); return value }
    pinWorkspace(id); setWorkspaceID(id); return value
  }, [workspaceID])
  const principal = useQuery({ queryKey: ['me'], queryFn: async () => {
    try { const value = await api.me(); setCSRF(value.csrfToken); return bindPrincipal(value) }
    catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error }
  }, retry: false, staleTime: Infinity })
  useEffect(() => {
    const onExpired = () => { setExpired(workspace.list().some((session) => session.dirty)); setCSRF(''); client.setQueryData(['me'], null) }
    const changed = () => { workspace.suspend(); setWorkspaceChanged(true) }
    const beforeUnload = (event: BeforeUnloadEvent) => { if (workspace.list().some((session) => session.dirty || session.pendingUploads > 0 || session.state === 'saving')) event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('folio:workspace-changed', changed)
    window.addEventListener('folio:unauthenticated', onExpired)
    return () => { window.removeEventListener('folio:workspace-changed', changed); window.removeEventListener('folio:unauthenticated', onExpired); window.removeEventListener('beforeunload', beforeUnload) }
  }, [client])
  // M0 回归演示只在开发服务器提供，生产入口始终进入认证。
  if (Spike && new URLSearchParams(location.search).get('demo') === '1') return <Suspense fallback={<p className="editor-loading">正在加载示例…</p>}><Spike /></Suspense>
  if (principal.isPending) return <main className="login-page"><p role="status">正在连接工作区…</p></main>
  if (principal.error) return <main className="login-page"><div className="login-form"><h1>暂时无法连接服务</h1><p role="alert">{principal.error.message}</p><button onClick={() => void principal.refetch()}>重试连接</button></div></main>
  if (!principal.data) return <Login expired={expired} onLogin={(value) => { bindPrincipal(value); client.setQueryData(['me'], value); void client.invalidateQueries({ queryKey: ['tree'] }) }} />
  if (workspaceChanged || (workspaceID && workspaceID !== principal.data.workspaceId)) return <main className="login-page"><div className="login-form"><h1>服务工作区已切换</h1><p role="alert">当前页面的自动保存已停止。请先下载旧页面中的草稿，再重新加载新工作区；旧恢复记录不会自动应用到新目录。</p>{workspace.list().filter((session) => ['markdown', 'text'].includes(session.viewer)).map((session) => <button className="button button-outline" key={session.id} onClick={() => downloadDraft(session.path, session.source)}>下载 {session.path}</button>)}<p><button className="button button-outline" onClick={() => location.reload()}>重新加载工作区</button></p></div></main>
  if (!workspaceID) return <main className="login-page"><p role="alert">{/^[a-f0-9]{64}$/.test(principal.data.workspaceId ?? '') ? '正在确认工作区身份…' : '服务未提供有效的工作区身份，请更新服务并重新加载。'}</p></main>
  return <Suspense fallback={<p className="editor-loading">正在打开工作区…</p>}><Workbench workspaceId={workspaceID} onLogout={() => { setCSRF(''); client.setQueryData(['me'], null); client.removeQueries({ queryKey: ['tree'] }) }} /></Suspense>
}
