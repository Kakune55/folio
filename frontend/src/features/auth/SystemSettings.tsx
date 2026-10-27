import { SettingsHeader } from './SettingsHeader'
import { SystemConfigurationPanel, SystemStatusPanel } from './SystemPanel'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import * as Dialog from '@radix-ui/react-dialog'
import { Plus, Search, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { DialogContent } from '../../components/ui/dialog-content'
import { api } from '../../services/api'
import type { Principal, UserAccount } from '../../services/api'
import { formatBytes } from '../../services/format'

export function SystemSettings({ principal }: { principal: Principal }) {
  const client = useQueryClient()
  const [page, setPage] = useState('用户管理')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [editing, setEditing] = useState<UserAccount | 'new' | null>(null)
  const [reset, setReset] = useState<UserAccount | null>(null)
  const [username, setUsername] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [quota, setQuota] = useState('5')
  const [unit, setUnit] = useState(1024 ** 3)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const users = useQuery({ queryKey: ['users', search, offset], queryFn: () => api.users(search, offset), enabled: principal.admin, retry: false })
  const begin = (user: UserAccount | 'new') => {
    setEditing(user); setPassword(''); setError('')
    setUsername(user === 'new' ? '' : user.username); setEnabled(user === 'new' ? true : user.enabled)
    const bytes = user === 'new' ? 5 * 1024 ** 3 : user.quota
    const nextUnit = bytes % 1024 ** 3 === 0 ? 1024 ** 3 : 1024 ** 2
    setUnit(nextUnit); setQuota(String(bytes / nextUnit))
  }
  if (!principal.admin) return <main className="settings-page"><h1>无权访问系统设置</h1><Link to="/">返回工作区</Link></main>
  const close = () => { if (!busy) { setEditing(null); setReset(null); setPassword(''); setError('') } }
  return <main className="settings-page">
    <SettingsHeader principal={principal} page="system" />
    <div className="settings-layout"><aside className="settings-nav"><h1>系统设置</h1><nav aria-label="系统管理">{['用户管理', '系统设置', '系统状态'].map((name) => <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => setPage(name)}>{name}</button>)}</nav></aside>
      {page === '系统设置' ? <SystemConfigurationPanel /> : page === '系统状态' ? <SystemStatusPanel /> : <section className="users-section" aria-labelledby="users-heading"><div className="users-heading"><h2 id="users-heading">用户管理 <span>{users.data?.total ?? ''}</span></h2><Button variant="outline" onClick={() => begin('new')}><Plus size={16} />创建用户</Button></div>
        <label className="user-search"><Search size={16} /><input aria-label="搜索用户名" placeholder="搜索用户名" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0) }} /></label>
        {notice && <p role="status">{notice}</p>}{users.isPending && <p role="status">正在读取用户…</p>}{users.error && <p role="alert">{users.error.message} <Button onClick={() => void users.refetch()}>重试</Button></p>}
        {users.data && <><div className="users-table-scroll"><table className="users-table"><thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>已用 / 配额</th><th>操作</th></tr></thead><tbody>
          {users.data.entries.map((user) => <tr key={user.id}><td>{user.username}</td><td>{user.admin ? '管理员' : '用户'}</td><td><span className={user.enabled ? '' : 'muted'}>{user.enabled ? '启用' : '禁用'}</span></td><td className={user.used !== null && user.used > user.quota ? 'quota-full' : ''}>{user.used === null ? <button onClick={() => void users.refetch()}>读取失败，重试</button> : `${formatBytes(user.used)} / ${formatBytes(user.quota)}`}</td><td><div className="user-actions"><Button onClick={() => begin(user)}>编辑</Button><Button onClick={() => { setReset(user); setPassword(''); setError('') }}>重置密码</Button></div></td></tr>)}
          {!users.data.entries.length && <tr><td colSpan={5} className="users-empty">没有匹配的用户</td></tr>}
        </tbody></table></div><div className="users-pagination"><span>共 {users.data.total} 个用户</span><Button disabled={offset === 0 || users.isFetching} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</Button><Button disabled={offset + 20 >= users.data.total || users.isFetching} onClick={() => setOffset(offset + 20)}>下一页</Button></div></>}
      </section>}</div>
    <Dialog.Root open={!!editing || !!reset} onOpenChange={(value) => { if (!value) close() }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content user-dialog">
      <Dialog.Title>{reset ? '重置密码' : editing === 'new' ? '创建用户' : '编辑用户'}</Dialog.Title><Dialog.Description>{reset ? `${reset.username} 的旧会话将立即失效。` : editing === 'new' ? '创建独立工作区。' : '修改账号与工作区配额。'}</Dialog.Description>
      <form onSubmit={async (event) => {
        event.preventDefault(); setError(''); setBusy(true)
        try {
          const bytes = Number(quota) * unit
          if (!reset && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 2 ** 50)) throw new Error('请输入有效配额（0–1024 TB）')
          if ((reset || editing === 'new') && (new TextEncoder().encode(password).length < 8 || new TextEncoder().encode(password).length > 1024)) throw new Error('密码须为 8–1024 字节')
          if (reset) await api.resetUserPassword(reset.id, password)
          else await api.saveUser(editing === 'new' ? 0 : editing!.id, { username, enabled, quota: bytes, password: editing === 'new' ? password : '' })
          setNotice(reset ? '密码已重置，旧会话已撤销。' : editing === 'new' ? '用户已创建。' : '用户已更新。')
          const selfReset = reset?.id === principal.id
          setEditing(null); setReset(null); setPassword('')
          if (selfReset) { window.dispatchEvent(new Event('folio:unauthenticated')); return }
          await Promise.all([client.invalidateQueries({ queryKey: ['users'] }), client.invalidateQueries({ queryKey: ['usage'] }), client.invalidateQueries({ queryKey: ['me'] })])
        } catch (e) { setError(e instanceof Error ? e.message : '保存失败') } finally { setBusy(false) }
      }}>
        {!reset && <><label htmlFor="user-name">用户名</label><input id="user-name" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,63}" maxLength={64} />
          <label htmlFor="user-status">状态</label><select id="user-status" value={enabled ? 'enabled' : 'disabled'} onChange={(e) => setEnabled(e.target.value === 'enabled')} disabled={editing !== 'new' && !!editing?.admin}><option value="enabled">启用</option><option value="disabled">禁用</option></select>
          <label htmlFor="user-quota">工作区配额</label><div className="quota-input"><input id="user-quota" type="number" min="0" step="any" required value={quota} onChange={(e) => setQuota(e.target.value)} /><select aria-label="配额单位" value={unit} onChange={(e) => setUnit(Number(e.target.value))}><option value={1024 ** 2}>MB</option><option value={1024 ** 3}>GB</option><option value={1024 ** 4}>TB</option></select></div>
          {editing !== 'new' && editing?.used !== null && editing && Number(quota) * unit < editing.used && <p role="status">低于当前用量：保留已有文件，阻止增加用量。</p>}
        </>}
        {(reset || editing === 'new') && <><label htmlFor="user-password">{reset ? '新密码' : '初始密码'}</label><input id="user-password" type="password" autoComplete="new-password" required maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} /><small>至少 8 字节，最多 1024 字节</small></>}
        {error && <p className="form-error" role="alert">{error}</p>}<div className="user-form-actions"><Button variant="outline" type="button" disabled={busy} onClick={close}>取消</Button><Button variant="outline" type="submit" disabled={busy}>{busy ? '正在保存…' : reset ? '重置密码' : editing === 'new' ? '创建' : '保存'}</Button></div>
      </form><Dialog.Close asChild><Button className="dialog-close" size="icon" aria-label="关闭用户表单" disabled={busy}><X size={17} /></Button></Dialog.Close>
    </DialogContent></Dialog.Portal></Dialog.Root>
  </main>
}
