import { SharePasswordInput } from './SharePasswordInput'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '../../components/ui/button'
import { DialogContent } from '../../components/ui/dialog-content'
import { Login } from '../auth/Login'
import type { FileMetadata, Principal } from '../../services/api'
import { publicRequest, shareFileURL } from './api'
import type { Share } from './api'
import { useTheme } from '../../app/useTheme'
const PdfViewer = lazy(() => import('../../viewers/PdfViewer'))
const SharedMarkdown = lazy(() => import('./SharedMarkdown'))

export default function SharePage({ id }: { id: string }) {
 useTheme()
 const [params, setParams] = useSearchParams()
 const [record, setRecord] = useState<Share>(), [password, setPassword] = useState('')
 const entering = useRef(false)
 const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
 const [login, setLogin] = useState(false), [importOpen, setImportOpen] = useState(false), [directory, setDirectory] = useState('')
 const [showSource, setShowSource] = useState(false), [imageError, setImageError] = useState(false)
 const info = useQuery({ queryKey: ['public-share', id], queryFn: () => publicRequest<{ protected: boolean }>(id), retry: false })
 const principal = useQuery({ queryKey: ['share-principal'], queryFn: async () => {
  const response = await fetch('/api/v1/auth/me', { credentials: 'same-origin' }).catch(() => {throw new Error('无法确认登录状态，请检查连接后重试。')})
  if (response.status === 401) return null
  if (!response.ok) throw new Error('无法确认登录状态，请重试。')
  return response.json() as Promise<Principal>
 }, retry: false, refetchOnWindowFocus: true })
 // 刷新仅检查既有访问资格；不自动消耗访问次数，也不会触发密码验证。
 useEffect(() => { const controller = new AbortController();void publicRequest<Share>(`${id}/manifest`, undefined, controller.signal).then(setRecord).catch(() => {});return () => controller.abort() }, [id])
 const file = record?.files.find(file => file.id === params.get('file')) ?? record?.files.find(file => file.path === record.root)
 const metadata = useQuery({ queryKey: ['public-file-metadata', id, record?.version, file?.id], enabled: !!record && !!file, queryFn: () => publicRequest<FileMetadata>(`${id}/files/${file!.id}/metadata`), retry: false, refetchOnWindowFocus: true, refetchInterval: record?.mode === 'live' ? 10000 : false })
 const content = useQuery({ queryKey: ['public-file-content', id, record?.version, file?.id, metadata.data?.mtime, metadata.data?.size], enabled: !!record && !!file && ['markdown', 'text'].includes(metadata.data?.viewer ?? ''), queryFn: () => publicRequest<{ content: string; html: string }>(`${id}/files/${file!.id}/content`), retry: false })
 const previewURL = file ? `${shareFileURL(id, file.id, 'preview')}?v=${encodeURIComponent(metadata.data?.mtime ?? '')}` : ''
 const select = (value: string) => {setParams({ file: value });setShowSource(false);setImageError(false);setNotice('')}
 const enter = async (code = password) => { if (entering.current) return;entering.current = true;setBusy(true);setError('');try {setRecord(await publicRequest<Share>(`${id}/enter`, { password: code }));setPassword('')} catch(e) {setError(e instanceof Error ? e.message : '无法进入分享')} finally {entering.current = false;setBusy(false)} }
 if (login) return <><Button className="share-login-back" onClick={() => setLogin(false)}>返回分享</Button><Login expired={false} onLogin={() => window.location.reload()} /></>
 return <main className="public-share"><header className="share-page-header"><Link className="share-brand" to="/"><span className="brand-mark">f</span>Folio</Link><span>文件分享</span><div className="share-header-actions">{principal.data ? <Link className="button" to="/">我的工作区</Link> : <Button onClick={() => setLogin(true)}>登录</Button>}</div></header>
  {!record ? <section className="share-entry"><h1>打开分享</h1>{info.isPending ? <p role="status">正在检查分享…</p> : info.error ? <p role="alert">{info.error.message}<Button onClick={() => void info.refetch()}>重试</Button></p> : <form onSubmit={e => {e.preventDefault();void enter()}}>{info.data?.protected && <><label htmlFor="access-password">六位数字访问密码</label><SharePasswordInput value={password} onChange={value => {setPassword(value);setError('');if (value.length === 6 && value !== password) void enter(value)}} disabled={busy} invalid={!!error} /></>}{error && <p id="share-access-error" className="form-error" role="alert">{error}</p>}<Button variant="outline" type="submit" disabled={busy}>{busy ? '正在验证…' : '进入分享'}</Button></form>}</section> : <>
   <div className="share-content-heading"><div><h1>{record.title}</h1><p>{record.mode === 'snapshot' ? '分享快照' : '实时内容'} · {record.files.length} 个文件</p></div><div className="share-content-actions"><Button variant="outline" disabled={!principal.data || !file || busy || !!metadata.error} title={principal.data ? '创建独立副本，不覆盖已有文件' : '登录后可保存到自己的工作区'} onClick={() => {setDirectory(`分享-${Date.now()}`);setError('');setImportOpen(true)}}>保存到我的工作区</Button>{file && <a className="button button-outline" href={shareFileURL(id, file.id, 'download')} download>下载当前文件</a>}</div></div>
   {principal.error && <p role="alert">{principal.error.message}<Button onClick={() => void principal.refetch()}>重试登录状态</Button></p>}
   {notice && <p role="status" className="share-inline-notice">{notice}</p>}
   <div className="share-reader-layout">{record.files.length > 1 && <nav className="share-files" aria-label="分享中的文件">{record.files.map(entry => <button key={entry.id} aria-current={file?.id === entry.id ? 'page' : undefined} onClick={() => select(entry.id)}>{entry.path}</button>)}</nav>}
   <section className="share-reader" aria-label="分享内容">{file && <div className="share-file-heading"><span>{file.path}</span><Button onClick={() => {setImageError(false);void metadata.refetch();void content.refetch()}}>刷新内容</Button>{metadata.data?.viewer === 'markdown' && <Button aria-pressed={showSource} onClick={() => setShowSource(value => !value)}>{showSource ? '查看预览' : '查看源码'}</Button>}</div>}
    {metadata.isPending && <p role="status">正在读取文件…</p>}
    {(metadata.error || content.error) && <div role="alert"><p>{metadata.error?.message ?? content.error?.message}</p><Button onClick={() => {setRecord(undefined);void info.refetch();setError('请重新进入分享；若已暂停或过期，将无法继续读取。')}}>重新检查分享</Button></div>}
    {metadata.data && !metadata.error && <Suspense fallback={<p role="status">正在加载预览…</p>}>
     {['markdown', 'text'].includes(metadata.data.viewer) ? content.isPending ? <p role="status">正在读取正文…</p> : content.data && (metadata.data.viewer === 'markdown' && !showSource ? <div onClick={event => {
      const a = event.target instanceof Element ? event.target.closest('a') : null;if (!a) return
      const href = a.getAttribute('href') ?? '';if (href.startsWith('?file=')) {event.preventDefault();const next = new URLSearchParams(href.slice(1)).get('file');if (next && record.files.some(file => file.id === next)) select(next)}
      else if (href === '#not-included') {event.preventDefault();setNotice('此文件未包含在分享中。')}
      else if (/^https?:\/\//i.test(href)) {event.preventDefault();window.open(href, '_blank', 'noopener,noreferrer')}
     }}><SharedMarkdown html={content.data.html} /></div> : <pre className="shared-source">{content.data.content}</pre>) : metadata.data.viewer === 'image' ? <div className="shared-image">{imageError ? <p role="alert">图片无法加载，分享可能已失效，请重新检查分享。</p> : <img src={previewURL} alt={file!.path} onError={() => setImageError(true)} />}</div> : metadata.data.viewer === 'pdf' ? <PdfViewer metadata={metadata.data} url={previewURL} downloadURL={shareFileURL(id, file!.id, 'download')} /> : <p>此类型提供原件下载，不执行或解压文件。</p>}
    </Suspense>}
   </section></div>
  </>}
  <Dialog.Root open={importOpen} onOpenChange={value => {if (!busy) setImportOpen(value)}}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><DialogContent className="dialog-content"><Dialog.Title>保存到我的工作区</Dialog.Title><Dialog.Description>{file?.path === record?.root ? '主文件与分享内附件一起保存' : '仅保存当前文件'}。创建独立文件夹并保留包内路径，同名目录不会覆盖。</Dialog.Description><form onSubmit={async event => {
   event.preventDefault();if (!principal.data || !file) return;setBusy(true);setError('')
   try {
    const response = await fetch(`/api/v1/shares/${id}/import`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': principal.data.csrfToken, 'X-Folio-Workspace': principal.data.workspaceId }, body: JSON.stringify({ file: file.id, directory }) })
    const result = await response.json();if (!response.ok) throw new Error(result.error?.message ?? '转存失败，请刷新工作区确认后重试')
    setImportOpen(false);setNotice(`已保存到我的工作区：${result.path}。这是独立副本。`)
   } catch(e) {setError(e instanceof TypeError || e instanceof SyntaxError ? '转存结果尚未确认，请先检查目标文件夹是否已创建，再重试。' : e instanceof Error ? e.message : '转存失败，请检查目标目录后重试')} finally {setBusy(false)}
  }}><label htmlFor="import-directory">新文件夹路径</label><input id="import-directory" value={directory} onChange={e => setDirectory(e.target.value)} required maxLength={4096}/>{error && <p role="alert" className="form-error">{error}</p>}<div className="dialog-actions"><Button type="button" disabled={busy} onClick={() => setImportOpen(false)}>取消</Button><Button type="submit" variant="outline" disabled={busy}>{busy ? '正在转存…' : '确认转存'}</Button></div></form></DialogContent></Dialog.Portal></Dialog.Root>
 </main>
}
