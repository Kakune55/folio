import { SettingsHeader } from './SettingsHeader'
import { useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, UserRound, HardDrive, AppWindow, Copy, Trash2, RefreshCw } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import { DialogContent } from '../../components/ui/dialog-content'
import { Button } from '../../components/ui/button'
import { api } from '../../services/api'
import type { AccessToken, Principal, TokenPermissions } from '../../services/api'
import { formatBytes } from '../../services/format'

const sections = [{ key: 'account', name: '账号', icon: UserRound }, { key: 'storage', name: '存储', icon: HardDrive }, { key: 'applications', name: '应用', icon: AppWindow }]
export function UserSettings({ principal }: { principal: Principal }) {
  const [params, setParams] = useSearchParams()
  const page = sections.some(s => s.key === params.get('tab')) ? params.get('tab') : 'account'
  return <main className="settings-page user-settings">
    <SettingsHeader principal={principal} page="user" />
    <div className="settings-layout"><aside className="settings-nav"><h1>用户设置</h1><nav aria-label="用户设置">{sections.map(({ key, name, icon: Icon }) => <button key={key} aria-current={page === key ? 'page' : undefined} onClick={() => setParams({ tab: key })}><Icon size={17} />{name}</button>)}</nav></aside>
      <div className="user-settings-body">{page === 'account' ? <AccountPanel principal={principal} /> : page === 'storage' ? <StoragePanel /> : <ApplicationsPanel />}</div>
    </div>
  </main>
}
function AccountPanel({ principal }: { principal: Principal }) {
  const [oldPassword, setOld] = useState(''), [password, setPassword] = useState(''), [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false)
  return <section className="setting-panel" aria-labelledby="account-heading"><h2 id="account-heading">账号</h2><div className="setting-panel-content"><p className="account-identity">{principal.username}<span>{principal.admin ? '管理员' : '用户'}</span></p><h3>修改密码</h3><p className="setting-description">修改后将退出所有登录，并撤销全部 Access Token。</p>
    <form className="account-password-form" onSubmit={async e => {
      e.preventDefault(); if (lock.current) return; setError(''); if (new TextEncoder().encode(password).length < 8 || new TextEncoder().encode(password).length > 1024) { setError('新密码须为 8–1024 字节'); return }; if (password !== confirm) { setError('两次输入的新密码不一致'); return }
      lock.current = true; setBusy(true)
      try { await api.changePassword(oldPassword, password); setOld(''); setPassword(''); setConfirm(''); window.dispatchEvent(new CustomEvent('folio:unauthenticated', { detail: { reason: 'password_changed' } })) }
      catch (e) { setError(e instanceof Error ? e.message : '修改失败，请重试') } finally { lock.current = false; setBusy(false) }
    }}><label htmlFor="account-old">原密码</label><input id="account-old" type="password" autoComplete="current-password" value={oldPassword} onChange={e => setOld(e.target.value)} required maxLength={1024} disabled={busy} />
      <label htmlFor="account-new">新密码</label><input id="account-new" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={1024} disabled={busy} /><p className="setting-description">至少 8 字节，最多 1024 字节。</p>
      <label htmlFor="account-confirm">确认新密码</label><input id="account-confirm" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required maxLength={1024} disabled={busy} />
      {error && <p role="alert" className="form-error">{error}</p>}<Button variant="outline" type="submit" disabled={busy}>{busy ? '正在修改…' : '修改密码'}</Button>
    </form>
  </div></section>
}
const categories: Record<string, string> = { documents: '文档', images: '图片', media: '音视频', other: '其他文件', trash: '回收站', shares: '分享快照' }
function StoragePanel() {
  const details = useQuery({ queryKey: ['storage-details'], queryFn: api.storageDetails, retry: false, staleTime: 0 })
  const value = details.data
  return <section className="setting-panel" aria-labelledby="storage-heading"><div className="setting-panel-heading"><h2 id="storage-heading">存储</h2><Button aria-label="刷新存储统计" disabled={details.isFetching} onClick={() => void details.refetch()}><RefreshCw size={16} />刷新</Button></div><div className="setting-panel-content">
    {details.isPending && <p role="status">正在统计存储用量…</p>}{details.error && <p role="alert" className="form-error">统计失败：{details.error.message} <Button onClick={() => void details.refetch()}>重试</Button></p>}
    {value && <><div className="storage-total"><strong>{formatBytes(value.used)}</strong><span>已使用，共 {formatBytes(value.quota)}</span></div>{value.used >= value.quota && <p className="form-error">{value.used > value.quota ? '已超出配额' : '配额已用满'}</p>}
      <div className="storage-composition" role="img" aria-label={`存储构成：${value.categories.map(c => `${categories[c.key]} ${formatBytes(c.bytes)}`).join('，')}，可用 ${formatBytes(Math.max(0, value.quota - value.used))}`}>{value.categories.filter(c => c.bytes > 0).map(c => <span key={c.key} className={`storage-color-${c.key}`} style={{ width: `${c.bytes / Math.max(value.quota, value.used, 1) * 100}%` }} />)}</div>
      <p className="setting-description">可用 {formatBytes(Math.max(0, value.quota - value.used))}{details.isFetching ? ' · 正在更新…' : ''}</p>
      <ul className="storage-categories">{value.categories.map(c => <li key={c.key}><span><i className={`storage-color-${c.key}`} />{categories[c.key]}</span><strong>{formatBytes(c.bytes)}</strong></li>)}</ul>
    </>}
  </div></section>
}
const permissionNames = { files: '文件', search: '搜索', trash: '回收站' }
const permissionText = { none: '无权限', read: '只读', write: '读写' }
const date = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN')
function ApplicationsPanel() {
  const client = useQueryClient()
  const tokens = useQuery({ queryKey: ['access-tokens'], queryFn: api.tokens, retry: false, refetchOnWindowFocus: false, refetchInterval: 60_000 })
  const [name, setName] = useState(''), [days, setDays] = useState('30')
  const [customDays, setCustomDays] = useState('')
  const [permissions, setPermissions] = useState<TokenPermissions>({ files: 'read', search: 'read', trash: 'none' })
  const [secret, setSecret] = useState(''), [copied, setCopied] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [remove, setRemove] = useState<AccessToken | null>(null)
  const secretInput = useRef<HTMLInputElement>(null), lock = useRef(false)
  const refresh = () => client.invalidateQueries({ queryKey: ['access-tokens'] })
  return <><section className="setting-panel" aria-labelledby="applications-heading"><div className="setting-panel-heading"><h2 id="applications-heading">管理 Access Token</h2><div className="token-guide-actions"><MCPGuide /><Link to="/api-docs">API 文档</Link></div></div><div className="setting-panel-content"><p className="setting-description">令牌可通过 MCP 或 REST API 访问本账号工作区，请为每个应用单独生成。</p>
    {tokens.isPending && <p role="status">正在读取令牌…</p>}{tokens.error && <p role="alert" className="form-error">{tokens.error.message} <Button onClick={() => void tokens.refetch()}>重试</Button></p>}
    <ul className="access-token-list">{tokens.data?.entries.map(t => <li key={t.id}><KeyRound size={23} /><div className="access-token-info"><strong>{t.name}</strong><p><code>{t.prefix}…</code> · 创建于 {date(t.createdAt)}</p><p>{t.lastUsedAt ? `最近使用 ${date(t.lastUsedAt)}` : '尚未使用'} · {t.expiresAt ? `${date(t.expiresAt)} 到期${t.expiresAt <= tokens.dataUpdatedAt / 1000 ? '（已过期）' : ''}` : '永不过期'}</p><p>{(Object.keys(permissionNames) as (keyof TokenPermissions)[]).map(k => `${permissionNames[k]}：${permissionText[t.permissions[k]]}`).join(' · ')}</p></div><Button className="token-delete" aria-label={`删除令牌 ${t.name}`} onClick={() => { setError(''); setRemove(t) }}><Trash2 size={15} />删除</Button></li>)}</ul>
    {tokens.data?.entries.length === 0 && <p className="token-empty">尚未创建访问令牌。</p>}
  </div></section>
  <section className="setting-panel" aria-labelledby="token-create-heading"><h2 id="token-create-heading">生成新的令牌</h2><div className="setting-panel-content">
    {secret ? <div className="token-result"><p role="status">令牌已生成。完整令牌仅在此显示，请立即保存。</p><label htmlFor="token-secret">Access Token</label><div className="token-secret-row"><input ref={secretInput} id="token-secret" value={secret} readOnly autoComplete="off" spellCheck={false} onFocus={e => e.target.select()} /><Button aria-label="复制令牌" onClick={async () => { try { await navigator.clipboard.writeText(secret); setCopied(true); setError('') } catch { secretInput.current?.focus(); secretInput.current?.select(); setError('复制失败，请手动复制上方令牌。') } }}><Copy size={16} />{copied ? '已复制' : '复制'}</Button></div><p className="setting-description">请求头：<code>Authorization: Bearer &lt;Access Token&gt;</code></p><Button variant="outline" onClick={() => { setSecret(''); setCopied(false); setError('') }}>我已保存</Button></div> : <form onSubmit={async e => {
      e.preventDefault(); if (lock.current) return; setError('')
      const duration = Number(days === 'custom' ? customDays : days)
      if (days !== '0' && (!Number.isInteger(duration) || duration < 1 || duration > 366)) { setError('有效期须为 1–366 天的整数。'); return }
      lock.current = true; setBusy(true)
      try { const result = await api.createToken(name, days === '0' ? 0 : Math.floor(Date.now() / 1000) + duration * 86400, permissions); setSecret(result.token); setName(''); await refresh() }
      catch (e) { setError(`${e instanceof Error ? e.message : '生成失败'}。若响应中断，请刷新令牌列表核对；无法取回的令牌可删除后重新生成。`) } finally { lock.current = false; setBusy(false) }
    }}><label htmlFor="token-name">令牌名称</label><input id="token-name" placeholder="例如：笔记归档脚本" value={name} onChange={e => setName(e.target.value)} maxLength={80} required disabled={busy} /><label htmlFor="token-expiry">有效期</label><select id="token-expiry" value={days} onChange={e => setDays(e.target.value)} disabled={busy}><option value="1">1 天</option><option value="7">7 天</option><option value="14">14 天</option><option value="30">30 天</option><option value="90">90 天</option><option value="180">180 天</option><option value="365">365 天</option><option value="0">永不过期</option><option value="custom">自定义</option></select>
      {days === 'custom' && <><label htmlFor="token-custom-days">自定义天数</label><input id="token-custom-days" type="number" inputMode="numeric" min={1} max={366} step={1} value={customDays} onChange={e => setCustomDays(e.target.value)} placeholder="例如：45" aria-describedby="token-custom-days-hint" required disabled={busy} /><p id="token-custom-days-hint" className="setting-description">1–366 天，从生成时起按每 24 小时计算。</p></>}
      <p className="setting-description">权限作用于本账号整个工作区。读写包含读取；回收和恢复文件还需文件读写权限。</p>
      <fieldset className="token-permissions" disabled={busy}><legend>API 访问权限</legend><div className="token-permission-head" aria-hidden="true"><span>资源</span><span>无权限</span><span>只读</span><span>读写</span></div>{(Object.keys(permissionNames) as (keyof TokenPermissions)[]).map(k => <div className="token-permission-row" key={k} role="group" aria-label={`${permissionNames[k]}权限`}><span>{permissionNames[k]}</span>{(['none', 'read', 'write'] as const).map(v => <label key={v}><input type="radio" name={`permission-${k}`} aria-label={`${permissionNames[k]}${permissionText[v]}`} checked={permissions[k] === v} onChange={() => setPermissions({ ...permissions, [k]: v })} /><span className="sr-only">{permissionText[v]}</span></label>)}</div>)}</fieldset>
      <p className="setting-description">令牌不能管理账号、系统设置、其他令牌或公开分享，也不能永久删除回收站文件。</p><Button variant="outline" type="submit" disabled={busy || Object.values(permissions).every(p => p === 'none')}>{busy ? '正在生成…' : '生成令牌'}</Button>
    </form>}
    {error && !remove && <p className="form-error" role="alert">{error}</p>}
  </div></section>
  <Dialog.Root open={!!remove} onOpenChange={open => { if (!open && !busy) { setRemove(null); setError('') } }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content"><Dialog.Title>删除访问令牌</Dialog.Title><Dialog.Description>删除“{remove?.name}”后，使用此令牌的应用将无法继续访问 API。</Dialog.Description>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><Button variant="outline" disabled={busy} onClick={() => { setRemove(null); setError('') }}>取消</Button><Button variant="outline" className="token-delete" disabled={busy} onClick={async () => { if (!remove || lock.current) return; lock.current = true; setBusy(true); setError(''); try { await api.deleteToken(remove.id); setRemove(null); await refresh() } catch (e) { setError(e instanceof Error ? e.message : '删除失败，请重试') } finally { lock.current = false; setBusy(false) } }}>{busy ? '正在删除…' : '确认删除'}</Button></div></DialogContent></Dialog.Portal></Dialog.Root>
  </>
}

function MCPGuide() {
  const endpoint = new URL('/mcp', window.location.origin).href
  const [copied, setCopied] = useState(false), [error, setError] = useState('')
  const address = useRef<HTMLInputElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  return <Dialog.Root onOpenChange={() => { setCopied(false); setError('') }}>
    <Dialog.Trigger asChild><Button>MCP 指南</Button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content mcp-guide" onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus({ preventScroll: true }) }}>
      <Dialog.Title ref={heading} tabIndex={-1}>MCP 快速配置</Dialog.Title>
      <Dialog.Description>使用现有 Access Token 连接 Folio，无需安装转接程序。客户端须支持 Streamable HTTP 和自定义请求头。</Dialog.Description>
      <ol className="mcp-guide-steps">
        <li><h3>生成专用令牌</h3><p>在本页为客户端单独生成令牌。仅查阅可选文件、搜索“只读”，回收站“无权限”；编辑需文件“读写”，回收和恢复还需回收站“读写”。完整令牌仅生成时显示，请安全保存。</p></li>
        <li><h3>添加远程 MCP 服务</h3><p>名称可填 Folio，传输方式选择 <code>Streamable HTTP</code>，连接地址使用：</p>
          <label className="sr-only" htmlFor="mcp-endpoint">MCP 连接地址</label><div className="token-secret-row"><input ref={address} id="mcp-endpoint" readOnly value={endpoint} spellCheck={false} onFocus={e => e.target.select()} /><Button aria-label="复制 MCP 地址" onClick={async () => { try { await navigator.clipboard.writeText(endpoint); setCopied(true); setError('') } catch { address.current?.focus(); address.current?.select(); setError('复制失败，请手动复制上方地址。') } }}><Copy size={16} />{copied ? '已复制' : '复制'}</Button></div>
        </li>
        <li><h3>配置认证请求头</h3><pre><code>{'Authorization: Bearer <Access Token>'}</code></pre><p>将 <code>&lt;Access Token&gt;</code> 替换为刚生成的完整令牌，<code>Bearer</code> 后保留一个空格。填在客户端的请求头或安全凭据配置中，不要放入 URL、聊天或工具参数。各客户端配置字段可能不同。</p></li>
        <li><h3>连接并发现工具</h3><p>保存后连接或刷新工具列表，即可发现当前权限允许的文件、搜索及回收恢复工具。仅能读取已保存文件，看不到浏览器草稿；修改仍需原版本保护。</p></li>
      </ol>
      <p className="setting-description">初版不支持 OAuth 登录或旧式 SSE。401 请检查令牌是否完整、过期或撤销；工具缺失请核对权限。生产环境使用 HTTPS，连接异常时检查代理是否转发 /mcp、Host 和 Authorization，以及 FOLIO_ORIGIN 是否与外部站点一致。</p>
      {error && <p role="alert" className="form-error">{error}</p>}{copied && <p role="status">MCP 地址已复制。</p>}
      <div className="dialog-actions"><Dialog.Close asChild><Button variant="outline">关闭</Button></Dialog.Close></div>
    </DialogContent></Dialog.Portal>
  </Dialog.Root>
}
