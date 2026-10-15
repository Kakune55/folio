import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { api } from '../../services/api'
import type { Principal } from '../../services/api'

export function Login({ onLogin, expired }: { onLogin: (principal: Principal) => void; expired: boolean }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <main className="login-page"><form className="login-form" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError('')
    try { const principal = await api.login('admin', password); setPassword(''); onLogin(principal) }
    catch (problem) { setError(problem instanceof Error ? problem.message : '登录失败') }
    finally { setBusy(false) }
  }}><div className="login-brand"><span className="brand-mark">f</span> Folio</div>
    <h1>{expired ? '重新连接你的工作区' : '回到你的文件与想法'}</h1>
    <p>{expired ? '当前页面的编辑草稿仍保留。登录后可以继续保存。' : '登录后，开始一段安静的书写。'}</p>
    <label htmlFor="username">账号</label><input id="username" name="username" value="admin" readOnly autoComplete="username" />
    <label htmlFor="password">密码</label><input id="password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required autoFocus maxLength={1024} />
    {error && <p className="form-error" role="alert">{error}</p>}
    <Button variant="outline" type="submit" disabled={busy}>{busy ? '正在登录…' : '进入工作区'}</Button>
    <p className="login-help">首次启动可从应用数据目录的 initial-password 文件获取密码，或由管理员指定密码文件。</p>
  </form></main>
}
