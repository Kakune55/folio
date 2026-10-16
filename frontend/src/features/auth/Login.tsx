import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { api } from '../../services/api'
import type { Principal } from '../../services/api'

export function Login({ onLogin, expired }: { onLogin: (principal: Principal) => void; expired: boolean }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <main className="login-page"><form className="login-form" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError('')
    try { const principal = await api.login(username, password); setPassword(''); onLogin(principal) }
    catch (problem) { setError(problem instanceof Error ? problem.message : '登录失败') }
    finally { setBusy(false) }
  }}><div className="login-brand"><span className="brand-mark">f</span> Folio</div>
    <h1>{expired ? '重新登录' : '登录'}</h1>
    {expired && <p>当前页面的草稿与待确认附件仍保留。</p>}
    <label htmlFor="username">账号</label><input id="username" name="username" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={64} autoComplete="username" />
    <label htmlFor="password">密码</label><input id="password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required autoFocus maxLength={1024} />
    {error && <p className="form-error" role="alert">{error}</p>}
    <Button variant="outline" type="submit" disabled={busy}>{busy ? '正在登录…' : '进入工作区'}</Button>
  </form></main>
}
