import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, Plus } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { DialogContent } from '../../components/ui/dialog-content'
import { shares } from './api'
import type { Share } from './api'
import { ShareDialog } from './ShareDialog'

export function ShareManager() {
 const [now] = useState(() => Date.now())
 const client = useQueryClient(), location = useLocation()
 const [actionError, setActionError] = useState('')
 const [pendingId, setPendingId] = useState<string | null>(null)
 const [offset, setOffset] = useState(0)
 const records = useQuery({ queryKey: ['shares', offset], queryFn: () => shares.list(offset), refetchInterval: 30000 })
 const [editing, setEditing] = useState<Share | 'new' | null>(null)
 const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
 const [remove, setRemove] = useState<Share | null>(null), [link, setLink] = useState('')
 const begin = (record: Share | 'new') => {setEditing(record);setError('')}
 const refresh = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['shares'] }), client.invalidateQueries({ queryKey: ['usage'] })]) }
 return <main className="share-manager"><header className="share-page-header"><Link className="button" to="/"><ArrowLeft size={16} />返回工作区</Link><h1>分享管理</h1><Button variant="outline" onClick={() => begin('new')}><Plus size={16} />创建分享</Button></header>
  {notice && <p role="status">{notice}</p>}
  {actionError && <p role="alert" className="form-error">{actionError}</p>}
  {link && <div className="share-copy"><label htmlFor="share-link">分享链接</label><input id="share-link" readOnly value={link} onFocus={e => e.target.select()} /><Button onClick={async () => { try { await navigator.clipboard.writeText(link);setNotice('链接已复制。') } catch { setNotice('无法自动复制，请选中分享链接手动复制。') } }}>复制链接</Button></div>}
  {records.isPending && <p role="status">正在读取分享…</p>}{records.error && <p role="alert">{records.error.message}<Button onClick={() => void records.refetch()}>重试</Button></p>}
  <div className="share-table-scroll"><table className="users-table"><thead><tr><th>内容</th><th>方式</th><th>状态</th><th>访问次数</th><th>有效期</th><th>操作</th></tr></thead><tbody>{records.data?.entries.map(record => <tr key={record.id}><td><strong>{record.title}</strong><small>{record.root} · {record.files.length} 个文件{record.protected ? ' · 密码保护' : ''}</small></td><td>{record.mode === 'snapshot' ? '快照' : '实时'}</td><td><span className="share-state">{record.disabled ? '暂停' : record.expiresAt && record.expiresAt <= now / 1000 ? '到期' : record.maxVisits && record.visits >= record.maxVisits ? '用尽' : '有效'}</span></td><td>{record.visits} / {record.maxVisits || '不限'}</td><td>{record.expiresAt ? new Date(record.expiresAt * 1000).toLocaleString('zh-CN') : '永久'}</td><td><div className="user-actions"><Button onClick={() => setLink(`${window.location.origin}/s/${record.id}`)}>链接</Button><Button onClick={() => begin(record)}>管理</Button><Button className="share-toggle" aria-busy={pendingId === record.id} disabled={pendingId !== null} onClick={async () => {setPendingId(record.id);setNotice('');setActionError('');try {await shares.save({root:record.root,title:record.title,mode:record.mode,maxVisits:record.maxVisits,expiresAt:record.expiresAt,disabled:!record.disabled,version:record.version},record.id);await refresh()} catch(e) {setActionError(e instanceof Error ? e.message : '更新分享状态失败')} finally {setPendingId(null)}}}>{record.disabled ? '继续' : '暂停'}</Button><Button onClick={() => {setRemove(record);setError('')}}>删除</Button></div></td></tr>)}</tbody></table></div>
  {records.data && <div className="users-pagination"><span>共 {records.data.total} 条分享</span><Button disabled={offset === 0 || records.isFetching} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</Button><Button disabled={offset + 20 >= records.data.total || records.isFetching} onClick={() => setOffset(offset + 20)}>下一页</Button></div>}
  {records.data?.entries.length === 0 && <p className="muted">当前页没有分享。创建后可在这里管理访问限制与分享内容。</p>}
  {editing && <ShareDialog record={editing} initialPath={(location.state as {path?: string}|null)?.path ?? ''} onClose={() => setEditing(null)} onSaved={result => {setEditing(null);setNotice('分享已保存。');setLink(`${window.location.origin}/s/${result.id}`)}} />}
  <Dialog.Root open={!!remove} onOpenChange={value => {if (!value && !busy) setRemove(null)}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><DialogContent className="dialog-content"><Dialog.Title>删除分享？</Dialog.Title><Dialog.Description>「{remove?.title}」的链接将失效，快照文件会被清理；原工作区文件和别人已转存的副本保留。</Dialog.Description>{error && <p role="alert">{error}</p>}<div className="dialog-actions"><Button disabled={busy} onClick={() => setRemove(null)}>取消</Button><Button variant="outline" disabled={busy} onClick={async () => {if (!remove) return;setBusy(true);try{await shares.remove(remove.id);setRemove(null);await refresh()}catch(e){setError(e instanceof Error ? e.message : '删除失败')}finally{setBusy(false)}}}>确认删除分享</Button></div></DialogContent></Dialog.Portal></Dialog.Root>
 </main>
}
