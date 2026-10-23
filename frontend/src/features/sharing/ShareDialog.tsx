import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { Link2, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { DialogContent } from '../../components/ui/dialog-content'
import { workspace } from '../../sessions/current'
import { shares } from './api'
import type { Share, ShareInput, Selection } from './api'
import { ShareAttachmentsDialog } from './ShareAttachmentsDialog'
const toLocal = (unix: number) => unix ? new Date(unix * 1000 - new Date(unix * 1000).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
export function ShareDialog({ record = 'new', initialPath = '', fixedPath = false, onClose, onSaved }: { record?: Share | 'new'; initialPath?: string; fixedPath?: boolean; onClose: () => void; onSaved: (share: Share) => void }) {
 const client = useQueryClient()
 const [link, setLink] = useState(''), [copyNotice, setCopyNotice] = useState('')
 const [root, setRoot] = useState(record === 'new' ? initialPath : record.root)
 const [title, setTitle] = useState(record === 'new' ? initialPath.split('/').at(-1) ?? '' : record.title), [mode, setMode] = useState<'snapshot' | 'live'>(record === 'new' ? 'snapshot' : record.mode)
 const [attachmentsConfirmed, setAttachmentsConfirmed] = useState(false)
 const [attachmentsOpen, setAttachmentsOpen] = useState(false)
 const [files, setFiles] = useState<Selection[] | null>(null)
 const [selected, setSelected] = useState<string[]>(record === 'new' ? [] : record.files.map(file => file.path))
 const [expires, setExpires] = useState(record === 'new' ? '' : toLocal(record.expiresAt)), [maxVisits, setMaxVisits] = useState(record === 'new' ? '1000' : String(record.maxVisits || 1000)), [password, setPassword] = useState('')
 const [disabled, setDisabled] = useState(record !== 'new' && record.disabled)
 const [expiryOn, setExpiryOn] = useState(record !== 'new' && !!record.expiresAt)
 const [visitsOn, setVisitsOn] = useState(record !== 'new' && !!record.maxVisits)
 const [passwordOn, setPasswordOn] = useState(record !== 'new' && record.protected)
 const [busy, setBusy] = useState(false), [error, setError] = useState('')
 const analyze = useCallback(async () => {
  setBusy(true);setError('');setFiles(null)
  try {
   // 分享仅使用已保存文件；所有已打开草稿先走原有条件保存与上传保护。
   for (const session of workspace.list()) if (!(await workspace.flush(session.path))) throw new Error('有文件未保存、存在冲突或上传未完成，请返回工作区处理后再分享。')
   const result = await shares.analyze(root, false);setFiles(result.files);setSelected(result.files.map(file => file.path))
   setTitle(current => current.trim() ? current : root.split('/').at(-1) ?? root)
   if (result.files.length > 1) setMode('snapshot')
  } catch (e) { setError(e instanceof Error ? e.message : '分析失败') } finally { setBusy(false) }
 }, [root])
 const close = () => { if (!busy) onClose() }
 const save = async () => {
  setBusy(true);setError('')
  try {
   if (record === 'new' && files === null) throw new Error('请先分析并确认分享文件清单。')
   const expiresAt = expiryOn && expires ? Math.floor(new Date(expires).getTime() / 1000) : 0
   if ((expiryOn && (!expires || expiresAt <= Date.now() / 1000)) || !Number.isFinite(expiresAt) || (visitsOn && (!/^\d+$/.test(maxVisits) || Number(maxVisits) < 1))) throw new Error('请输入有效时间与次数。')
   const input: ShareInput = { root, title, mode, expiresAt, maxVisits: visitsOn ? Number(maxVisits) : 0, disabled, ...(files ? { files: files.filter(file => selected.includes(file.path)).map(({ path, revision }) => ({ path, revision })) } : {}), ...(!passwordOn ? { password: '' } : password ? { password } : record === 'new' || !record.protected ? { password } : {}), ...(record && record !== 'new' ? { version: record.version } : {}) }
   const result = await shares.save(input, record && record !== 'new' ? record.id : undefined)
   await Promise.all([client.invalidateQueries({ queryKey: ['shares'] }), client.invalidateQueries({ queryKey: ['usage'] })]);if (fixedPath) setLink(`${window.location.origin}/s/${result.id}`);else onSaved(result)
  } catch (e) { setError(e instanceof Error ? e.message : '保存失败') } finally { setBusy(false) }
 }
 // 初始化只分析，不会创建公开链接；确认清单后才提交。
 useEffect(() => {
  if (!fixedPath) return
  let cancelled = false
  void Promise.resolve().then(() => { if (!cancelled) void analyze() })
  return () => { cancelled = true }
 }, [fixedPath, analyze])
 return (<Dialog.Root open onOpenChange={value => { if (!value) close() }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content share-dialog">{link ? <><Dialog.Title>分享链接已创建</Dialog.Title><Dialog.Description>可复制链接发送给他人，在右上角分享管理中调整限制与暂停。</Dialog.Description><div className="share-created"><label htmlFor="created-share-link">分享链接</label><input id="created-share-link" readOnly value={link} onFocus={e => e.target.select()}/></div>{copyNotice && <p role="status">{copyNotice}</p>}<div className="dialog-actions"><Button onClick={close}>完成</Button><Button className="share-confirm" onClick={async () => {try {await navigator.clipboard.writeText(link);setCopyNotice('链接已复制。')} catch {setCopyNotice('无法自动复制，请选中链接手动复制。')}}}>复制链接</Button></div></> : <><Dialog.Title>{record === 'new' ? '创建外部链接' : '管理分享'}</Dialog.Title><Dialog.Description className="visually-hidden">设置分享内容与访问限制，确认后生成只读外部链接。</Dialog.Description>
   <div className="share-create-file"><span className="share-file-symbol"><Link2 size={24}/></span><strong title={root}>{root.split('/').at(-1) || '选择要分享的文件'}</strong></div>
   <form onSubmit={e => {e.preventDefault();void save()}}>
    {!fixedPath && <><label htmlFor="share-root">主文件路径</label><input id="share-root" value={root} disabled={record !== 'new' || busy} onChange={e => {setRoot(e.target.value);setFiles(null);setSelected([]);setAttachmentsConfirmed(false)}} required maxLength={4096} placeholder="例如：笔记/项目说明.md" /></>}
    {/\.(md|markdown)$/i.test(root) && <div className="share-attachment-summary"><div><span>附件</span><small>{Math.max(0, (files ? selected.length : record === 'new' ? 1 : record.files.length) - 1) > 0 ? `已选择 ${Math.max(0, (files ? selected.length : record === 'new' ? 1 : record.files.length) - 1)} 个附件` : '不包含附件'}</small></div><Button type="button" variant="outline" disabled={busy || (record !== 'new' && record.mode === 'live')} onClick={() => setAttachmentsOpen(true)}>选择附件</Button></div>}
    {((!fixedPath && (record === 'new' ? !files : !/\.(md|markdown)$/i.test(root))) || error) && <Button type="button" variant="outline" disabled={busy || !root} onClick={() => void analyze()}>{busy ? '正在处理…' : record === 'new' ? '分析分享清单' : '重新分析主文件'}</Button>}
    {record !== 'new' && !files && <p className="small-label">未重新分析时仅修改访问设置。</p>}
    {!fixedPath && <><label htmlFor="share-title">分享标题</label><input id="share-title" value={title} onChange={e => setTitle(e.target.value)} required maxLength={150} /></>}
    <fieldset className="share-type" disabled={record !== 'new' || busy}><legend className="visually-hidden">分享方式</legend><div className="share-type-row"><span aria-hidden="true">分享方式</span><div className="share-type-options" data-mode={mode}><span className="share-type-thumb" aria-hidden="true" />{(['snapshot', 'live'] as const).map(value => <label key={value}><input type="radio" name="share-mode" value={value} checked={mode === value} disabled={value === 'live' && selected.length > 1} onChange={() => setMode(value)} /><span>{value === 'snapshot' ? '快照' : '实时'}</span></label>)}</div></div></fieldset>
    <div className="share-access-settings">
     <section className="share-setting"><div className="share-setting-heading"><span>到期时间{expiryOn && <span className="share-required"> *</span>}</span>{!expiryOn && <small>关闭则链接永久有效</small>}<input className="share-switch" type="checkbox" role="switch" aria-label="启用到期时间" checked={expiryOn} disabled={busy} onChange={e => setExpiryOn(e.target.checked)} /></div>{expiryOn && <input aria-label="到期时间" type="datetime-local" value={expires} required disabled={busy} onChange={e => setExpires(e.target.value)} />}</section>
     <section className="share-setting"><div className="share-setting-heading"><span>密码{passwordOn && <span className="share-required"> *</span>}</span><input className="share-switch" type="checkbox" role="switch" aria-label="启用密码" checked={passwordOn} disabled={busy} onChange={e => setPasswordOn(e.target.checked)} /></div>{passwordOn && <div className="share-password-row"><input aria-label="六位数字密码" type="text" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={6} value={password} disabled={busy} required={record === 'new' || !record.protected} placeholder={record !== 'new' && record.protected ? '留空保留原密码' : '请输入六位数字密码'} onChange={e => setPassword(e.target.value)} /><Button type="button" disabled={busy} onClick={() => {const values = new Uint32Array(1);do {crypto.getRandomValues(values)} while(values[0] >= 4294000000);setPassword(String(values[0] % 1000000).padStart(6, '0'))}}>随机生成密码</Button></div>}</section>
     <section className="share-setting"><div className="share-setting-heading"><span>可访问次数{visitsOn && <span className="share-required"> *</span>}</span><input className="share-switch" type="checkbox" role="switch" aria-label="启用访问次数限制" checked={visitsOn} disabled={busy} onChange={e => setVisitsOn(e.target.checked)} /></div>{visitsOn && <input aria-label="可访问次数" type="number" min={1} max={1000000} step={1} value={maxVisits} disabled={busy} onChange={e => setMaxVisits(e.target.value)} required />}</section>
    </div>
    {record !== 'new' && <label className="share-checkbox"><input type="checkbox" checked={disabled} onChange={e => setDisabled(e.target.checked)} />暂停此分享</label>}
    {busy && <p role="status">正在处理分享文件…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><Button type="button" onClick={close} disabled={busy}>取消</Button><Button type="submit" className="share-confirm" variant="outline" disabled={busy || (record === 'new' && files === null)}>{busy ? '正在保存…' : record === 'new' ? '确定' : '保存访问设置'}</Button></div>
   </form></>}<Button className="dialog-close" size="icon" aria-label="关闭分享设置" disabled={busy} onClick={close}><X size={16}/></Button>
  {attachmentsOpen && <ShareAttachmentsDialog root={root} selected={attachmentsConfirmed || record !== 'new' ? selected : null} onClose={() => setAttachmentsOpen(false)} onConfirm={(nextFiles, nextSelected) => {setFiles(nextFiles);setSelected(nextSelected);setAttachmentsConfirmed(true);if(nextSelected.length > 1) setMode('snapshot');setTitle(current => current.trim() ? current : root.split('/').at(-1) ?? root);setError('');setAttachmentsOpen(false)}} />}
  </DialogContent></Dialog.Portal></Dialog.Root>)
}
