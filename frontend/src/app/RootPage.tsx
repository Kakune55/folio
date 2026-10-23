import { lazy, Suspense } from 'react'
import { Link, useLocation } from 'react-router'
import App from './App'
const SharePage = lazy(() => import('../features/sharing/SharePage'))
export default function RootPage() {
 const location = useLocation()
 const match = /^\/s\/([a-f0-9]{48})$/.exec(location.pathname)
 if (location.pathname.startsWith('/s/') && !match) return <main className="login-page"><section className="login-form"><h1>分享链接无效</h1><p role="alert">请核对完整分享链接，或向分享者重新获取。</p><Link className="button button-outline" to="/">返回工作区</Link></section></main>
 return match ? <Suspense fallback={<p role="status">正在打开分享…</p>}><SharePage key={match[1]} id={match[1]} /></Suspense> : <App />
}
