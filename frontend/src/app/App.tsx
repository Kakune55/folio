import { lazy, Suspense, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, setCSRF } from '../services/api'
import { Login } from '../features/auth/Login'
import { useTheme } from './useTheme'
import { workspace } from '../sessions/current'
const Workbench = lazy(() => import('./Workbench'))
const Spike = import.meta.env.DEV ? lazy(() => import('./Spike')) : null

export default function App() {
  useTheme()
  const client = useQueryClient()
  const [expired, setExpired] = useState(false)
  const principal = useQuery({ queryKey: ['me'], queryFn: async () => {
    try { const value = await api.me(); setCSRF(value.csrfToken); return value }
    catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error }
  }, retry: false, staleTime: Infinity })
  useEffect(() => {
    const onExpired = () => { setExpired(workspace.list().some((session) => session.dirty)); setCSRF(''); client.setQueryData(['me'], null) }
    const beforeUnload = (event: BeforeUnloadEvent) => { if (workspace.list().some((session) => session.dirty || session.pendingUploads > 0 || session.state === 'saving')) event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('folio:unauthenticated', onExpired)
    return () => { window.removeEventListener('folio:unauthenticated', onExpired); window.removeEventListener('beforeunload', beforeUnload) }
  }, [client])
  // M0 回归演示只在开发服务器提供，生产入口始终进入认证。
  if (Spike && new URLSearchParams(location.search).get('demo') === '1') return <Suspense fallback={<p className="editor-loading">正在加载示例…</p>}><Spike /></Suspense>
  if (principal.isPending) return <main className="login-page"><p role="status">正在连接工作区…</p></main>
  if (principal.error) return <main className="login-page"><div className="login-form"><h1>暂时无法连接服务</h1><p role="alert">{principal.error.message}</p><button onClick={() => void principal.refetch()}>重试连接</button></div></main>
  if (!principal.data) return <Login expired={expired} onLogin={(value) => { client.setQueryData(['me'], value); void client.invalidateQueries({ queryKey: ['tree'] }) }} />
  return <Suspense fallback={<p className="editor-loading">正在打开工作区…</p>}><Workbench onLogout={() => { setCSRF(''); client.setQueryData(['me'], null); client.removeQueries({ queryKey: ['tree'] }) }} /></Suspense>
}
