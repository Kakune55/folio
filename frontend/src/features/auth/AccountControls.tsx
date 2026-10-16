import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { DialogContent } from '../../components/ui/dialog-content'
import { Button } from '../../components/ui/button'
import { formatBytes } from '../../services/format'
import { api } from '../../services/api'
import type { Principal } from '../../services/api'

export function AccountControls({ principal, onSettings }: { principal: Principal; onSettings: () => void }) {
  const usage = useQuery({ queryKey: ['usage', principal.workspaceId], queryFn: api.usage, refetchInterval: 5000, retry: false })
  const [open, setOpen] = useState(false)
  const [oldPassword, setOld] = useState('')
  const [newPassword, setNew] = useState('')
  const [confirmPassword, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const percent = usage.data ? usage.data.quota > 0 ? Math.min(100, usage.data.used / usage.data.quota * 100) : usage.data.used > 0 ? 100 : 0 : 0
  return <div className="account-controls">
    <div className="account-row"><button className="account-name" onClick={() => setOpen(true)} aria-label={`账号设置 ${principal.username}`}>{principal.username}</button>{principal.admin && <Link to="/system-setting" onClick={onSettings}>系统设置</Link>}</div>
    {usage.error ? <div role="alert">用量读取失败 <button onClick={() => void usage.refetch()}>重试</button></div> : usage.data ? <div className={`quota-usage ${usage.data.used >= usage.data.quota ? 'quota-full' : ''}`} role="group" aria-label="工作区用量" title="包含文件、附件和回收站"><span>{formatBytes(usage.data.used)} / {formatBytes(usage.data.quota)}{usage.data.used > usage.data.quota ? ' · 已超额' : usage.data.used === usage.data.quota ? ' · 已用满' : usage.data.used >= usage.data.quota * .9 ? ' · 即将用满' : ''}</span><span className="quota-meter" role="progressbar" aria-label="工作区配额使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent * 10) / 10} aria-valuetext={`${formatBytes(usage.data.used)} / ${formatBytes(usage.data.quota)}`}><span style={{ width: `${percent}%` }} /></span></div> : <span role="status">正在读取用量…</span>}
    <Dialog.Root open={open} onOpenChange={(value) => { if (!busy) { setOpen(value); setOld(''); setNew(''); setConfirm(''); setError('') } }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content">
      <Dialog.Title>账号设置</Dialog.Title><Dialog.Description>{principal.username}</Dialog.Description>
      {done ? <><p role="status">密码已修改，旧会话已退出。当前未保存内容仍在页面中。</p><Button variant="outline" onClick={() => window.dispatchEvent(new Event('folio:unauthenticated'))}>重新登录</Button></> : <form onSubmit={async (event) => {
        event.preventDefault(); setError('')
        if (newPassword !== confirmPassword) { setError('两次输入的新密码不一致'); return }
        setBusy(true)
        try { await api.changePassword(oldPassword, newPassword); setOld(''); setNew(''); setConfirm(''); setDone(true) }
        catch (e) { setError(e instanceof Error ? e.message : '修改失败') } finally { setBusy(false) }
      }}><label htmlFor="old-password">原密码</label><input id="old-password" type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOld(e.target.value)} required maxLength={1024} />
        <label htmlFor="new-password">新密码</label><input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} required minLength={12} maxLength={1024} />
        <label htmlFor="confirm-password">确认新密码</label><input id="confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirm(e.target.value)} required minLength={12} maxLength={1024} />
        {error && <p className="form-error" role="alert">{error}</p>}<Button className="form-submit" variant="outline" type="submit" disabled={busy}>{busy ? '正在修改…' : '修改密码'}</Button>
      </form>}
      <Dialog.Close asChild><Button className="dialog-close" size="icon" aria-label="关闭账号设置" disabled={busy}><X size={17} /></Button></Dialog.Close>
    </DialogContent></Dialog.Portal></Dialog.Root>
  </div>
}
