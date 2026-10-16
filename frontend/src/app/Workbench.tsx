import { Component, Suspense, useMemo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowDownToLine, BookOpen, Braces, ChevronRight, FilePlus2, FileText, FolderOpen, FolderPlus, Info, LogOut, Monitor, Moon, PanelLeft, RefreshCw, Save, Search, Sun, Trash2, Upload, X } from 'lucide-react'
import { Button } from '../components/ui/button'
import { api, downloadDraft, uploadFile, fileURL } from '../services/api'
import type { FileContent } from '../services/api'
import { workspace } from '../sessions/current'
import { reloadCleanSession } from '../sessions/reconcile'
import { useExternalChanges } from '../features/explorer/useExternalChanges'
import { useUI } from '../stores/ui'
import { SearchDialog } from '../features/search/SearchDialog'
import { Explorer } from '../features/explorer/Explorer'
import { TrashDialog } from '../features/explorer/TrashDialog'
import { useEntryOperations } from '../features/explorer/useEntryOperations'
import type { Session } from '../sessions/workspace'
import { DocumentEditor } from '../editors/registry'
import { imageMarkdown, relativeFileLink, resolveFileLink } from '../editors/milkdown/bridge'
import type { CrepeBridge } from '../editors/milkdown/bridge'

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path)
const basename = (path: string) => path.split('/').at(-1) ?? path
const isSessionBusy = (session: Session) => session.pendingUploads > 0 || session.locked || session.state === 'saving'
const saveLabels = { saved: '已保存', dirty: '未保存', saving: '正在保存…', error: '保存失败 · 草稿已保留', conflict: '版本冲突 · 草稿已保留' }

class EditorBoundary extends Component<{ children: ReactNode; retry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div className="editor-error" role="alert"><p>编辑器加载失败。草稿仍保留，可下载或重试源码模式。</p><Button variant="outline" onClick={this.props.retry}>重试源码模式</Button></div> : this.props.children }
}

export default function Workbench({ onLogout }: { onLogout: () => void }) {
  useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const client = useQueryClient()
  const { activePath, sidebar, theme, open, toggleSidebar, setTheme } = useUI()
  const current = workspace.has(activePath) ? workspace.get(activePath) : undefined
  const [directory, setDirectory] = useState('')
  const [trashOpen, setTrashOpen] = useState(false)
  const [searchMode, setSearchMode] = useState<'names' | 'full' | null>(null)
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const uploadInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [createKind, setCreateKind] = useState<'file' | 'directory' | null>(null)
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editorAttempt, setEditorAttempt] = useState(0)
  const [comparison, setComparison] = useState<{ session: Session; path: string }>()
  const [comparisonError, setComparisonError] = useState('')
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [copyPath, setCopyPath] = useState('')
  const comparisonSequence = useRef(0)
  const external = useExternalChanges()
  const [remote, setRemote] = useState<FileContent>()
  const requestSequence = useRef(0)
  const onBlocked = useCallback((message: string) => setNotice(message), [setNotice])
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon
  const themeLabel = theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'

  const operations = useEntryOperations({
    uploading, onNotice: onBlocked,
    onRemap: (from, to) => {
      const active = useUI.getState().activePath
      if (active === from || active.startsWith(`${from}/`)) open(to + active.slice(from.length))
      setDirectory((current) => current === from || current.startsWith(`${from}/`) ? to + current.slice(from.length) : current)
    },
    onDelete: (path) => {
      const active = useUI.getState().activePath
      if (active === path || active.startsWith(`${path}/`)) open(workspace.list().at(-1)?.path ?? '')
      setDirectory((current) => current === path || current.startsWith(`${path}/`) ? path.split('/').slice(0, -1).join('/') : current)
    },
  })

  const openFile = useCallback(async (path: string) => {
    const sequence = ++requestSequence.current
    setNotice('')
    if (workspace.has(path)) { open(path); setLoading(false); return }
    setLoading(true)
    try {
      const metadata = await api.metadata(path)
      const file = ['markdown', 'text'].includes(metadata.viewer) ? await api.read(path) : undefined
      if (sequence !== requestSequence.current) return
      workspace.add({ path, source: file?.content ?? '', revision: file?.revision ?? '', viewer: metadata.viewer, metadata, mode: metadata.viewer === 'markdown' ? 'rich' : 'source' })
      open(path)
    } catch (error) { if (sequence === requestSequence.current) setNotice(error instanceof Error ? error.message : '文件打开失败') }
    finally { if (sequence === requestSequence.current) setLoading(false) }
  }, [open, setNotice, setLoading])

  useEffect(() => {
    if (!focusPath || activePath !== focusPath || loading || searchMode) return
    const root = document.querySelector('.document-panel')
    if (!root) return
    const focus = () => {
      const editor = root.querySelector<HTMLElement>('[role="textbox"]')
      if (!editor || editor.closest('[inert]') || getComputedStyle(editor).visibility === 'hidden' || document.querySelector('[role="dialog"]')) return
      editor.focus(); setFocusPath(null)
    }
    const observer = new MutationObserver(focus)
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'inert', 'aria-busy'] })
    const frame = requestAnimationFrame(focus)
    const timeout = setTimeout(() => setFocusPath(null), 5000)
    return () => { observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timeout) }
  }, [focusPath, activePath, loading, searchMode])

  const bridge = useMemo<CrepeBridge | undefined>(() => current?.viewer === 'markdown' ? {
    beginUpload: () => workspace.beginUpload(current.path),
    endUpload: () => workspace.endUpload(current.path),
    upload: async (file) => {
      const extension = /\.(png|jpg|jpeg|webp|gif)$/i.exec(file.name)?.[1] ?? ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[file.type] ?? 'png'
      const named = new File([file], `image-${crypto.randomUUID().slice(0, 12)}.${extension}`, { type: file.type })
      const parent = current.path.split('/').slice(0, -1).join('/')
      const metadata = await uploadFile(named, parent, (percent) => setNotice(`${basename(current.path)}：正在上传图片 ${percent}%`), true)
      void client.invalidateQueries({ queryKey: ['tree'] }); setNotice(`${basename(current.path)}：图片已上传。`)
      return relativeFileLink(current.path, metadata.path)
    },
    imageURL: (href) => { try { return fileURL(resolveFileLink(current.path, href), true) } catch { return '' } },
    openLink: (href) => {
      try {
        if (/^https?:\/\//i.test(href)) { const url = new URL(href); window.open(url.href, '_blank', 'noopener,noreferrer'); return }
        if (href.startsWith('#')) { setNotice('当前版本暂不支持段内锚点跳转。'); return }
        void openFile(resolveFileLink(current.path, href))
      } catch (error) { setNotice(error instanceof Error ? error.message : '此链接不受支持') }
    },
    detachedImage: (url, alt) => workspace.appendAttachment(current.path, imageMarkdown(url, alt)),
  } : undefined, [current, client, openFile, setNotice])
  const uploadAttachments = async (files: File[]) => {
    if (uploading || files.length === 0) return
    setUploading(true)
    const failures: string[] = []
    let completed = 0
    try {
      for (const file of files) {
        try {
          await uploadFile(file, directory, (percent) => setNotice(`正在上传 ${file.name} · ${percent}%`))
          completed++; void client.invalidateQueries({ queryKey: ['tree'] })
        } catch (error) { failures.push(`${file.name}：${error instanceof Error ? error.message : '上传失败'}`) }
      }
      setNotice(failures.length ? `已上传 ${completed} 个文件。以下文件未确认成功，请检查后重试：${failures.join('；')}` : `已上传 ${completed} 个文件。`)
    } finally { setUploading(false); if (uploadInput.current) uploadInput.current.value = '' }
  }

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (uploading || workspace.list().some((session) => session.dirty || session.pendingUploads > 0 || session.state === 'saving')) event.preventDefault() }
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); setSearchMode('names'); event.stopPropagation(); return }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchMode('full'); event.stopPropagation(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && !(event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]'))) { event.preventDefault(); useUI.getState().toggleSidebar(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); const path = useUI.getState().activePath; if (workspace.has(path) && ['markdown', 'text'].includes(workspace.get(path).viewer)) void workspace.save(path) }
    }
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('keydown', keydown, true)
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', keydown, true) }
  }, [uploading])

  const closeFile = async (session: Session) => {
    if (!(await workspace.flush(session.path))) { setNotice('此文件尚未保存，已保留标签页。请重试保存或先处理冲突。'); return }
    if (workspace.remove(session.path) && activePath === session.path) open(workspace.list().at(-1)?.path ?? '')
  }
  const startCreate = (kind: 'file' | 'directory') => { setCreateError(''); setName(kind === 'file' ? '未命名.md' : '新建文件夹'); setCreateKind(kind) }
  const loadComparison = async () => {
    if (!current) return
    const session = current, path = session.path, sequence = ++comparisonSequence.current
    setComparison({ session, path }); setRemote(undefined); setComparisonError(''); setComparisonLoading(true)
    setCopyPath(path.replace(/(\.[^/.]+)?$/, `.本地-${crypto.randomUUID().slice(0, 12)}$1`))
    try { const file = await api.read(path); if (sequence === comparisonSequence.current) setRemote(file) }
    catch (error) { if (sequence === comparisonSequence.current) setComparisonError(error instanceof Error ? error.message : '磁盘版本读取失败，可另存本地草稿') }
    finally { if (sequence === comparisonSequence.current) setComparisonLoading(false) }
  }
  const closeComparison = () => { if (!busy) { comparisonSequence.current++; setComparison(undefined) } }
  const handleKeepSeparate = async () => {
    if (!comparison) return
    const { session, path: originalPath } = comparison
    if (!workspace.has(originalPath) || workspace.get(originalPath) !== session || session.path !== originalPath) { setComparisonError('原会话路径已变化，请关闭后重新比较'); return }
    if (isSessionBusy(session)) { setComparisonError('保存、上传或文件操作尚未结束，请稍后重试'); return }
    if (copyPath === originalPath || workspace.has(copyPath) || workspace.isLocked(copyPath)) { setComparisonError('请选择不同于原文件且未打开的新副本路径'); return }
    setBusy(true); setComparisonError('')
    const source = session.source, generation = session.generation
    try {
      const saved = await api.create(copyPath, source)
      if (workspace.has(saved.path) || workspace.isLocked(saved.path)) throw new Error('副本已写入，但目标路径的会话又有变化；原草稿仍保留，请刷新目录确认')
      workspace.add({ path: saved.path, source, revision: saved.revision, mode: session.mode })
      void client.invalidateQueries({ queryKey: ['tree'] })
      if (session.source !== source || session.path !== originalPath || session.generation !== generation || isSessionBusy(session)) { setComparisonError('副本已保存，但原会话又有新变化，仍保留原草稿。'); return }
      if (remote) workspace.acceptRemote(originalPath, remote.content, remote.revision)
      else { workspace.acceptRemote(originalPath, source, session.revision); workspace.remove(originalPath) }
      comparisonSequence.current++; setComparison(undefined); open(saved.path); setNotice('本地副本已保存，未覆盖磁盘原文件。')
    } catch (error) { setComparisonError(error instanceof Error ? error.message : '保留副本失败，草稿仍在') }
    finally { setBusy(false) }
  }
  const reloadCurrent = async () => {
    if (!current) return
    try { await reloadCleanSession(workspace, current); setNotice('已加载磁盘版本。') }
    catch (error) { setNotice(error instanceof Error ? error.message : '重新加载失败，当前正文仍保留') }
  }

  return <div className={`workbench ${sidebar ? '' : 'sidebar-hidden'}`} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={(event) => { if (event.defaultPrevented || !event.dataTransfer.files.length) return; event.preventDefault(); void uploadAttachments(Array.from(event.dataTransfer.files)) }}>
    <header className="topbar"><div className="brand"><span className="brand-mark">f</span><span>Folio</span><span className="workspace-name">个人工作区</span></div>
      <input ref={uploadInput} className="visually-hidden" type="file" multiple aria-label="上传附件文件" onChange={(event) => void uploadAttachments(Array.from(event.target.files ?? []))} />
      <div className="topbar-actions"><Button className="quick-open-trigger" aria-label="快速打开文件" title="快速打开（Ctrl/Cmd+P）" onClick={() => setSearchMode('names')}><Search size={16} /><span>查找文件…</span><kbd>Ctrl P</kbd></Button><Button size="icon" aria-label="打开回收站" title="回收站" onClick={() => setTrashOpen(true)}><Trash2 size={17} /></Button><Button size="icon" aria-label="上传附件" title={`上传到：${directory || '工作区根目录'}`} disabled={uploading} onClick={() => uploadInput.current?.click()}><Upload size={17} /></Button><Button size="icon" aria-label={`主题：${themeLabel}`} title={`主题：${themeLabel}`} onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}><ThemeIcon size={17} /></Button>
        <Button size="icon" aria-label="退出登录" title="保存全部文件并退出登录" disabled={uploading} onClick={async () => {
          for (const session of workspace.list()) if (!(await workspace.flush(session.path))) { setNotice('有文件未能保存，已保留登录状态。请先处理错误或冲突。'); return }
          try { await api.logout(); onLogout() } catch (error) { setNotice(error instanceof Error ? error.message : '退出失败') }
        }}><LogOut size={17} /></Button></div>
    </header>
    <div className="workspace-body"><aside className="explorer" aria-label="文件资源管理器" inert={!sidebar}>
      <div className="explorer-heading"><span>文件</span><div className="explorer-tools"><Button size="icon" aria-label="新建笔记" title="新建笔记" onClick={() => startCreate('file')}><FilePlus2 size={15} /></Button><Button size="icon" aria-label="新建文件夹" title="新建文件夹" onClick={() => startCreate('directory')}><FolderPlus size={15} /></Button><Button size="icon" aria-label="刷新文件列表" title="刷新文件列表" disabled={external.checking} onClick={() => void external.check()}><RefreshCw size={14} /></Button></div></div>
      <button className={`folder-label root-folder ${directory === '' ? 'directory-selected' : ''}`} onClick={() => setDirectory('')}><FolderOpen size={16} /> 工作区</button>
      <Explorer active={activePath} directory={directory} setDirectory={setDirectory} onOpen={(path) => void openFile(path)} onRename={operations.rename} onMove={operations.showMove} onDelete={operations.showDelete} />
      <div className="explorer-foot"><span className="small-label">文件为本 · 自由书写</span><p>普通文件，标准 Markdown。<br />编辑后自动保存。</p></div>
    </aside>
    <main className="main-pane"><div className="tabs-row"><Button size="icon" aria-label={sidebar ? '收起文件列表' : '展开文件列表'} aria-expanded={sidebar} onClick={toggleSidebar}><PanelLeft size={16} /></Button><div className="tabs" role="tablist" aria-label="打开的文件">
      {workspace.list().map((session, index, files) => <div key={session.path} className={`tab-container ${activePath === session.path ? 'active' : ''}`}><button id={`file-tab-${index}`} role="tab" aria-controls="document-panel" aria-selected={activePath === session.path} tabIndex={activePath === session.path ? 0 : -1} className={`tab ${activePath === session.path ? 'active' : ''}`} title={session.path} onClick={() => void openFile(session.path)} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? files.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + files.length) % files.length
        void openFile(files[next].path); document.getElementById(`file-tab-${next}`)?.focus()
      }}><FileText size={14} /><span>{basename(session.path)}</span>{session.dirty && <span className="dirty-dot" aria-label="未保存" />}</button><Button size="icon" className="tab-close" aria-label={`关闭 ${session.path}`} onClick={() => void closeFile(session)}><X size={12} /></Button></div>)}
    </div></div>
    <section className="document-panel" id="document-panel" role={current ? 'tabpanel' : undefined} aria-labelledby={current ? `file-tab-${workspace.list().findIndex((session) => session.path === activePath)}` : undefined}>
      {current && <div className="document-toolbar"><div className="breadcrumb"><span>工作区</span><ChevronRight size={13} /><span title={current.path}>{current.path}</span></div><div className="document-actions">
        {current.viewer === 'markdown' && <div className="mode-switch" aria-label="编辑模式"><Button aria-pressed={current.mode === 'rich'} onClick={() => workspace.setMode(current.path, 'rich')}><BookOpen size={14} />富文本</Button><Button aria-pressed={current.mode === 'source'} onClick={() => workspace.setMode(current.path, 'source')}><Braces size={14} />源码</Button></div>}
        {['markdown', 'text'].includes(current.viewer) && <Button size="icon" aria-label="保存当前文件" title="保存（Ctrl/Cmd+S）" disabled={current.locked || current.state === 'saving' || current.state === 'conflict' || !current.dirty || !!current.external} onClick={() => void workspace.save(current.path)}><Save size={16} /></Button>}{['markdown', 'text'].includes(current.viewer) ? <Button size="icon" aria-label="下载当前草稿" title="下载当前草稿" onClick={() => downloadDraft(current.path, current.source)}><ArrowDownToLine size={16} /></Button> : <a className="button button-icon" href={fileURL(current.path)} download aria-label="下载文件"><ArrowDownToLine size={16} /></a>}
      </div></div>}
      {notice && <div className="notice" role="status"><Info size={16} /><span>{notice}</span><Button size="icon" aria-label="关闭提示" onClick={() => setNotice('')}><X size={14} /></Button></div>}
      {external.warning && <div className="notice" role="status"><Info size={16} /><span>{external.warning}</span><Button disabled={external.checking} onClick={() => void external.check()}>重新检查</Button></div>}
      {current?.external && !current.dirty && <div className="notice" role="status"><Info size={16} /><span>{current.external === 'missing' ? '磁盘文件已被移走或删除，当前显示缓存内容。可下载草稿或另存副本。' : '磁盘文件已发生变化，当前显示旧版本。重新加载会重置撤销历史。'}</span>{current.external === 'changed' && <Button variant="outline" onClick={() => void reloadCurrent()}>加载磁盘版本</Button>}{['markdown', 'text'].includes(current.viewer) && <Button onClick={() => void loadComparison()}>比较并另存</Button>}</div>}
      {current && ['error', 'conflict'].includes(current.state) && <div className="notice save-error" role="alert"><Info size={16} /><span>{current.error}</span>{current.state === 'conflict' ? <Button variant="outline" onClick={() => void loadComparison()}>比较版本</Button> : <Button variant="outline" onClick={() => void workspace.save(current.path)}>重试保存</Button>}</div>}
      {loading ? <div className="editor-loading" role="status">正在读取文件…</div> : current ? <div className="editor-scroll" inert={current.locked} key={current.path + current.mode + current.generation + editorAttempt}><EditorBoundary retry={() => { workspace.setMode(current.path, 'source'); setEditorAttempt((value) => value + 1) }}><Suspense fallback={<div className="editor-loading">正在加载编辑器…</div>}><DocumentEditor session={current} sessions={workspace} onBlocked={onBlocked} bridge={bridge} /></Suspense></EditorBoundary></div> : <div className="empty-workspace"><FileText size={28} strokeWidth={1.3} /><h1>为想法留一个位置</h1><p>从左侧打开文件，或写下第一篇笔记。</p><Button variant="outline" onClick={() => startCreate('file')}><FilePlus2 size={15} />新建笔记</Button></div>}
    </section></main></div>
    <footer className="statusbar"><span className="save-status" role="status">{current ? current.external && !current.dirty ? '磁盘版本已变化' : current.locked ? '正在处理文件操作…' : current.pendingUploads ? '正在上传图片…' : ['markdown', 'text'].includes(current.viewer) ? saveLabels[current.state] : '只读预览' : '已连接工作区'}</span><span className="history-hint">切换保留正文，重置撤销历史</span><span>{current && ['markdown', 'text'].includes(current.viewer) ? 'UTF-8' : 'Folio'}{current && <span className="status-divider">{isMarkdown(current.path) ? 'Markdown' : basename(current.path).split('.').at(-1)?.toUpperCase()}</span>}</span></footer>

    {searchMode && <SearchDialog key={searchMode} mode={searchMode} onClose={() => setSearchMode(null)} onMode={setSearchMode} onOpen={(path) => { setFocusPath(path); void client.invalidateQueries({ queryKey: ['tree'] }); void openFile(path).then(() => { if (useUI.getState().activePath !== path) setFocusPath(null) }) }} />}
    {operations.dialogs}<TrashDialog open={trashOpen} onOpenChange={setTrashOpen} />
    <Dialog.Root open={createKind !== null} onOpenChange={(value) => { if (!value && !busy) setCreateKind(null) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content">
      <Dialog.Title>{createKind === 'directory' ? '新建文件夹' : '新建笔记'}</Dialog.Title><Dialog.Description>创建位置：{directory || '工作区根目录'}</Dialog.Description>
      <form onSubmit={async (event) => {
        event.preventDefault(); setBusy(true); setCreateError('')
        const path = directory ? `${directory}/${name}` : name
        try {
          if (createKind === 'directory') { await api.mkdir(path); setDirectory(path) }
          else { await api.create(path); await openFile(path) }
          await client.invalidateQueries({ queryKey: ['tree'] }); setCreateKind(null)
        } catch (error) { setCreateError(error instanceof Error ? error.message : '创建失败') }
        finally { setBusy(false) }
      }}><label htmlFor="entry-name">名称</label><input id="entry-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={255} autoFocus onFocus={(event) => event.target.select()} />{createError && <p className="form-error" role="alert">{createError}</p>}<div className="dialog-actions"><Button type="button" disabled={busy} onClick={() => setCreateKind(null)}>取消</Button><Button type="submit" variant="outline" disabled={busy}>{busy ? '正在创建…' : '创建'}</Button></div></form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>

    <Dialog.Root open={!!comparison} onOpenChange={(value) => { if (!value) closeComparison() }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content conflict-dialog"><Dialog.Title>文件版本发生冲突</Dialog.Title><Dialog.Description>本地草稿与磁盘版本均已保留。关闭窗口不会覆盖任意版本。{comparison?.path}</Dialog.Description>
      <div className="compare-columns"><div><label htmlFor="comparison-local">本地草稿</label><textarea id="comparison-local" readOnly value={comparison?.session.source ?? ''} /></div><div><label htmlFor="comparison-remote">磁盘版本</label><textarea id="comparison-remote" readOnly value={remote?.content ?? (comparisonLoading ? '正在读取磁盘版本…' : '磁盘正文不可读；仍可另存本地草稿。')} /></div></div>
      {comparisonError && <p className="form-error" role="alert">{comparisonError}</p>}
      <label htmlFor="copy-path">副本路径</label><input id="copy-path" value={copyPath} onChange={(event) => setCopyPath(event.target.value)} disabled={busy} /><p className="small-label">输入工作区相对路径。原目录已不存在时，请选择仍存在的目录；已有同名文件不会被覆盖。</p>
      <div className="dialog-actions"><Button onClick={() => comparison && downloadDraft(comparison.path, comparison.session.source)}>下载本地草稿</Button><Button variant="outline" disabled={comparisonLoading || busy || !copyPath.trim()} onClick={() => void handleKeepSeparate()}>{busy ? '正在保存副本…' : remote ? '保留本地副本并加载磁盘版本' : '另存本地副本'}</Button><Button onClick={closeComparison} disabled={busy}>稍后处理</Button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>
}
