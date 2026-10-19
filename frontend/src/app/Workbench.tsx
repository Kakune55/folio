import { AppearanceDialog } from '../features/appearance/AppearanceDialog'
import { useAppearance } from '../stores/appearance'
import type { CSSProperties } from 'react'
import { useLocation } from 'react-router'
import { TabMenu } from '../features/tabs/TabMenu'
import type { CloseTabsAction } from '../features/tabs/TabMenu'
import type { SearchTarget, SearchLocated } from '../features/search/location'
import { DialogContent } from '../components/ui/dialog-content'
import { Component, Suspense, useMemo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowDownToLine, BookOpen, Braces, Camera, ChevronRight, FilePlus2, FileText, FolderPlus, History, Info, Keyboard, LogOut, Monitor, Moon, PanelLeft, PanelRight, RefreshCw, Save, Search, SlidersHorizontal, Sun, Trash2, Upload, X } from 'lucide-react'
import { Button } from '../components/ui/button'
import { api, downloadDraft, uploadFile, fileURL } from '../services/api'
import { AccountControls } from '../features/auth/AccountControls'
import type { Principal, FileContent } from '../services/api'
import { workspace } from '../sessions/current'
import { reloadCleanSession } from '../sessions/reconcile'
import { useExternalChanges } from '../features/explorer/useExternalChanges'
import { useUI } from '../stores/ui'
import { getDraftManager } from '../sessions/drafts'
import { DraftRecovery } from '../features/recovery/DraftRecovery'
import { FileStatus } from '../features/search/FileStatus'
import { SearchDialog } from '../features/search/SearchDialog'
import { useMobile } from './useMobile'
import { uploadQueue } from '../sessions/uploads'
import type { PendingUpload } from '../sessions/uploads'
import { UploadFailures } from '../features/explorer/UploadFailures'
import { ExplorerPanel } from '../features/explorer/ExplorerPanel'
import { FileIcon } from '../features/explorer/FileIcon'
import { Explorer } from '../features/explorer/Explorer'
import { TrashDialog } from '../features/explorer/TrashDialog'
import { useEntryOperations } from '../features/explorer/useEntryOperations'
import type { Session } from '../sessions/workspace'
import { DocumentEditor } from '../editors/registry'
import { imageMarkdown, relativeFileLink, resolveFileLink } from '../editors/milkdown/bridge'
import type { CrepeBridge } from '../editors/milkdown/bridge'

const basename = (path: string) => path.split('/').at(-1) ?? path
const isSessionBusy = (session: Session) => session.pendingUploads > 0 || session.locked || session.state === 'saving'
const saveLabels = { saved: '已保存', dirty: '未保存', saving: '正在保存…', error: '保存失败 · 草稿已保留', conflict: '版本冲突 · 草稿已保留' }

class EditorBoundary extends Component<{ children: ReactNode; retry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div className="editor-error" role="alert"><p>编辑器加载失败。草稿仍保留，可下载或重试源码模式。</p><Button variant="outline" onClick={this.props.retry}>重试源码模式</Button></div> : this.props.children }
}

export default function Workbench({ onLogout, workspaceId, principal }: { onLogout: () => void; workspaceId: string; principal: Principal }) {
  useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const client = useQueryClient()
  const { activePath, sidebar, theme, open, toggleSidebar, setSidebar, setTheme } = useUI()
  const { width, fontSize } = useAppearance()
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const mobile = useMobile()
  const route = useLocation()
  const current = workspace.has(activePath) ? workspace.get(activePath) : undefined
  const manager = useMemo(() => getDraftManager(workspaceId, workspace), [workspaceId])
  const recovery = useSyncExternalStore(manager.subscribe, manager.snapshot)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  useEffect(() => { manager.start() }, [manager])
  const [directory, setDirectory] = useState('')
  const [trashOpen, setTrashOpen] = useState(false)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [closingTabs, setClosingTabs] = useState(false)
  const closingTabsRef = useRef(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const [searchTarget, setSearchTarget] = useState<SearchTarget>()
  const searchSequence = useRef(0)
  const [notice, setNotice] = useState('')
  const cameraInput = useRef<HTMLInputElement>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const uploads = useSyncExternalStore(uploadQueue.subscribe, uploadQueue.snapshot)
  const [discardUpload, setDiscardUpload] = useState<PendingUpload>()
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
  const onSearchLocated = useCallback<SearchLocated>((target, found) => {
    if (target.id !== searchSequence.current) return
    setSearchTarget(undefined)
    if (!found && target.contentMatch) setNotice('当前正文中未找到该关键词，文件可能已修改；Markdown 标记中的命中可切换源码后重搜。')
  }, [])
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
    setSearchTarget((target) => target?.path === path ? target : undefined)
    const sequence = ++requestSequence.current
    setNotice('')
    if (workspace.has(path)) { open(path); if (window.matchMedia('(max-width: 767px)').matches) setSidebar(false); setLoading(false); return }
    setLoading(true)
    try {
      const metadata = await api.metadata(path)
      const file = ['markdown', 'text'].includes(metadata.viewer) ? await api.read(path) : undefined
      if (sequence !== requestSequence.current) return
      workspace.add({ path, source: file?.content ?? '', revision: file?.revision ?? '', viewer: metadata.viewer, metadata, mode: metadata.viewer === 'markdown' ? 'rich' : 'source' })
      open(path); if (window.matchMedia('(max-width: 767px)').matches) setSidebar(false)
    } catch (error) { if (sequence === requestSequence.current) setNotice(error instanceof Error ? error.message : '文件打开失败') }
    finally { if (sequence === requestSequence.current) setLoading(false) }
  }, [open, setNotice, setLoading, setSidebar])

  useEffect(() => {
    if (!focusPath || activePath !== focusPath || loading || searchOpen) return
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
  }, [focusPath, activePath, loading, searchOpen])

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
  const uploadAttachments = async (files: File[], retry?: PendingUpload[]) => {
    if (uploading || files.length === 0) return
    const entries = retry ?? files.map((file) => uploadQueue.add(file, directory))
    if (retry) retry.forEach((entry) => uploadQueue.retry(entry.id, directory))
    setUploading(true)
    const failures: string[] = []
    let completed = 0
    try {
      for (const entry of entries) {
        const file = entry.file
        try {
          await uploadFile(file, directory, (percent) => setNotice(`正在上传 ${file.name} · ${percent}%`), entry.imageOnly)
          uploadQueue.remove(entry.id); completed++; void client.invalidateQueries({ queryKey: ['tree'] })
        } catch (error) { const message = error instanceof Error ? error.message : '上传失败'; uploadQueue.fail(entry.id, message); failures.push(`${file.name}：${message}`) }
      }
      setNotice(failures.length ? `已上传 ${completed} 个文件。以下文件未确认成功，请检查后重试：${failures.join('；')}` : `已上传 ${completed} 个文件。`)
    } finally { setUploading(false); if (uploadInput.current) uploadInput.current.value = ''; if (cameraInput.current) cameraInput.current.value = '' }
  }

  const closeFile = useCallback(async (session: Session, focusAfter = true) => {
    const path = session.path
    if (!workspace.has(path) || workspace.get(path) !== session) return false
    if (!(await workspace.flush(path))) { setNotice('此文件尚未保存或仍有未完成操作，已保留标签页。请重试保存或先处理冲突。'); return false }
    if (!workspace.has(path) || workspace.get(path) !== session || session.path !== path) return false
    if (workspace.remove(path)) {
      setSearchTarget((target) => target?.path === path ? undefined : target)
      if (useUI.getState().activePath === path) open(workspace.list().at(-1)?.path ?? '')
      if (focusAfter) requestAnimationFrame(() => (document.querySelector<HTMLButtonElement>('.tabs [role="tab"][aria-selected="true"]') ?? document.getElementById('explorer-toggle'))?.focus())
      return true
    }
    setNotice('文件仍有未完成操作，已保留标签页。')
    return false
  }, [open])

  const closeTabs = useCallback(async (action: CloseTabsAction, anchor: Session) => {
    if (closingTabsRef.current) return
    const files = workspace.list(), index = files.indexOf(anchor)
    if (index < 0) return
    const saved = (file: Session) => !file.dirty && file.state === 'saved' && !file.pendingUploads && !file.locked
    const targets = files.filter((file, position) => action === 'one' ? file === anchor : action === 'others' ? file !== anchor : action === 'right' ? position > index : action === 'saved' ? saved(file) : true)
    closingTabsRef.current = true; setClosingTabs(true)
    let retained = 0
    try {
      for (const session of targets) {
        if (!workspace.has(session.path) || workspace.get(session.path) !== session) continue
        // 关闭已保存仅处理仍然干净的会话，执行期间新增的输入不能被顺带保存并关闭。
        if (action === 'saved' && !saved(session)) continue
        if (!(await closeFile(session, false))) retained++
      }
      if (retained) setNotice(`${retained} 个标签页因保存失败、冲突或未完成操作而保留，请处理后重试。`)
    } catch (error) { setNotice(`关闭标签页未完成，未关闭的正文仍保留：${error instanceof Error ? error.message : '未知错误'}`) }
    finally {
      closingTabsRef.current = false; setClosingTabs(false)
      requestAnimationFrame(() => (document.querySelector<HTMLButtonElement>('.tabs [role="tab"][aria-selected="true"]') ?? document.getElementById('explorer-toggle'))?.focus())
    }
  }, [closeFile])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (uploading || uploads.length || workspace.list().some((session) => session.dirty || session.pendingUploads > 0 || session.state === 'saving')) event.preventDefault() }
    const keydown = (event: KeyboardEvent) => {
      if (location.pathname === '/system-setting') return
      const key = event.key.toLowerCase(), modifier = event.ctrlKey || event.metaKey
      if (document.querySelector('[role="dialog"]')) {
        if (modifier && !event.altKey && ((!event.shiftKey && (key === 'p' || key === 's')) || (event.shiftKey && key === 'f'))) event.preventDefault()
        return
      }
      if (modifier && event.altKey && key === 'w') {
        event.preventDefault(); event.stopPropagation()
        const path = useUI.getState().activePath; if (workspace.has(path)) void closeFile(workspace.get(path))
        return
      }
      if (event.altKey && !modifier && ['PageUp', 'PageDown'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        const files = workspace.list(), index = files.findIndex((session) => session.path === useUI.getState().activePath)
        if (files.length) void openFile(files[(index + (event.key === 'PageDown' ? 1 : -1) + files.length) % files.length].path)
        return
      }
      if (key === '?' && !(event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]'))) { event.preventDefault(); setShortcutsOpen(true); return }
      if (modifier && !event.altKey && !event.shiftKey && key === 'p') { event.preventDefault(); setSearchOpen(true); event.stopPropagation(); return }
      if (modifier && !event.altKey && event.shiftKey && key === 'f') { event.preventDefault(); setSearchOpen(true); event.stopPropagation(); return }
      if (modifier && !event.altKey && !event.shiftKey && key === 'b' && !(event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]'))) { event.preventDefault(); useUI.getState().toggleSidebar(); return }
      if (modifier && !event.altKey && !event.shiftKey && key === 's') { event.preventDefault(); const path = useUI.getState().activePath; if (workspace.has(path) && ['markdown', 'text'].includes(workspace.get(path).viewer)) void workspace.save(path) }
    }
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('keydown', keydown, true)
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', keydown, true) }
  }, [uploading, uploads.length, closeFile, openFile])


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

  return <div style={{ '--editor-width': `${width}px`, '--editor-font-size': `${fontSize}px` } as CSSProperties} className={`workbench ${sidebar ? '' : 'sidebar-hidden'}`} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={(event) => { if (event.defaultPrevented || !event.dataTransfer.files.length) return; event.preventDefault(); void uploadAttachments(Array.from(event.dataTransfer.files)) }}>
    <AppearanceDialog open={appearanceOpen} onOpenChange={setAppearanceOpen} />
    <header className="topbar"><div className="brand"><span className="brand-mark">f</span><span>Folio</span><span className="workspace-name">个人工作区</span></div>
      <input ref={uploadInput} className="visually-hidden" tabIndex={-1} aria-hidden="true" type="file" multiple aria-label="上传附件文件" onChange={(event) => void uploadAttachments(Array.from(event.target.files ?? []))} />
      <input ref={cameraInput} className="visually-hidden" tabIndex={-1} aria-hidden="true" type="file" accept="image/*" capture="environment" aria-label="拍照上传文件" onChange={(event) => void uploadAttachments(Array.from(event.target.files ?? []).map((file) => new File([file], `photo-${crypto.randomUUID().slice(0, 12)}-${file.name}`, { type: file.type, lastModified: file.lastModified })))} />
      <div className="topbar-actions"><Button className="quick-open-trigger" aria-label={mobile ? '搜索' : '搜索 Ctrl P'} aria-keyshortcuts="Control+p Meta+p Control+Shift+f Meta+Shift+f" title="搜索（Ctrl/Cmd+P）" onClick={() => setSearchOpen(true)}><Search size={16} /><span>搜索</span><kbd aria-hidden="true">Ctrl P</kbd></Button><Button size="icon" aria-label="打开回收站" title="回收站" onClick={() => setTrashOpen(true)}><Trash2 size={17} /></Button><Button size="icon" aria-label="上传附件" title={`上传到：${directory || '工作区根目录'}`} disabled={uploading} onClick={() => uploadInput.current?.click()}><Upload size={17} /></Button><Button size="icon" aria-label={`主题：${themeLabel}`} title={`主题：${themeLabel}`} onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}><ThemeIcon size={17} /></Button>
        <Button size="icon" aria-label={navigationOpen ? '收起大纲与缩略图' : '展开大纲与缩略图'} title="大纲 / 文本缩略图" aria-pressed={navigationOpen} onClick={() => setNavigationOpen((value) => !value)}><PanelRight size={17} /></Button><Button size="icon" aria-label="个性化" title="个性化" onClick={() => setAppearanceOpen(true)}><SlidersHorizontal size={17} /></Button><Button size="icon" aria-label="查看快捷键" title="快捷键" onClick={() => setShortcutsOpen(true)}><Keyboard size={17} /></Button><Button size="icon" aria-label="退出登录" title="保存全部文件并退出登录" disabled={uploading} onClick={async () => {
          if (uploadQueue.snapshot().length) { setNotice('还有待确认的附件，请先重试上传或下载原件并移除待上传记录。'); return }
          for (const session of workspace.list()) if (!(await workspace.flush(session.path))) { setNotice('有文件未能保存，已保留登录状态。请先处理错误或冲突。'); return }
          try { await api.logout(); onLogout() } catch (error) { setNotice(error instanceof Error ? error.message : '退出失败') }
        }}><LogOut size={17} /></Button></div>
    </header>
    <div className="workspace-body"><ExplorerPanel mobile={mobile} open={route.pathname !== '/system-setting' && sidebar && !(mobile && (createKind !== null || !!comparison || trashOpen || appearanceOpen || shortcutsOpen || recoveryOpen || !!searchOpen || !!discardUpload || operations.dialogOpen))} onOpenChange={setSidebar}>
      <div className="explorer-heading"><span>文件</span><div className="explorer-tools">{mobile && <Button size="icon" aria-label="关闭文件列表" onClick={() => setSidebar(false)}><X size={17} /></Button>}<Button size="icon" aria-label="新建笔记" title="新建笔记" onClick={() => startCreate('file')}><FilePlus2 size={15} /></Button><Button size="icon" aria-label="新建文件夹" title="新建文件夹" onClick={() => startCreate('directory')}><FolderPlus size={15} /></Button><Button size="icon" aria-label="刷新文件列表" title="刷新文件列表" disabled={external.checking} onClick={() => void external.check()}><RefreshCw size={14} /></Button></div></div>
      {mobile && <div className="drawer-upload-row"><Button className="drawer-upload" variant="outline" disabled={uploading} onClick={() => uploadInput.current?.click()}><Upload size={16} />上传到{directory ? `「${directory}」` : '工作区'}</Button><Button size="icon" variant="outline" disabled={uploading} aria-label="拍照上传" title="拍照上传到当前目录" onClick={() => cameraInput.current?.click()}><Camera size={17} /></Button></div>}
      {mobile && notice && <p className="tree-message" role="status">{notice}</p>}
      {mobile && <UploadFailures busy={uploading} onDiscard={setDiscardUpload} onRetry={(entries) => void uploadAttachments(entries.map((entry) => entry.file), entries)} />}
      <Explorer active={activePath} directory={directory} setDirectory={setDirectory} onOpen={(path) => void openFile(path)} onRename={operations.rename} onMove={operations.showMove} onDelete={operations.showDelete} onDropMove={operations.moveToDirectory} onNotice={onBlocked} disabled={uploading} />
      <div className="explorer-foot"><AccountControls principal={principal} onSettings={() => { if (mobile) setSidebar(false) }} /></div>
    </ExplorerPanel>
    <main className="main-pane"><div className="tabs-row"><Button id="explorer-toggle" size="icon" aria-label={sidebar ? '收起文件列表' : '展开文件列表'} aria-expanded={sidebar} onClick={toggleSidebar}><PanelLeft size={16} /></Button><div className="tabs" role={workspace.list().length ? 'tablist' : undefined} aria-label={workspace.list().length ? '打开的文件' : undefined}>
      {workspace.list().map((session, index, files) => <TabMenu key={session.path} session={session} files={files} busy={closingTabs} onClose={(action, anchor) => { void closeTabs(action, anchor) }}><div className={`tab-container ${activePath === session.path ? 'active' : ''}`}><button id={`file-tab-${index}`} role="tab" aria-controls="document-panel" aria-describedby="file-tab-help" aria-selected={activePath === session.path} tabIndex={activePath === session.path ? 0 : -1} className={`tab ${activePath === session.path ? 'active' : ''}`} title={session.path} onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('.tab-close-target')) void closeFile(session)
        else void openFile(session.path)
      }} onKeyDown={(event) => {
        if (event.key === 'Delete' && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); void closeFile(session); return }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? files.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + files.length) % files.length
        void openFile(files[next].path); document.getElementById(`file-tab-${next}`)?.focus()
      }}><FileIcon path={session.path} size={14} /><span>{basename(session.path)}</span>{session.dirty && <span className="dirty-dot" aria-label="未保存" />}<span className="tab-close-target" aria-hidden="true" title={`关闭 ${session.path}`}><X size={12} /></span></button></div></TabMenu>)}
    </div>{current && <Button size="icon" className="close-current-tab" aria-label={`关闭 ${current.path}`} title="保存并关闭当前标签（也可在标签上按 Delete）" onClick={() => void closeFile(current)}><X size={14} /></Button>}<span id="file-tab-help" className="visually-hidden">左右方向键切换标签，Home 和 End 跳到首尾。按 Delete 保存并关闭此标签；保存失败时保留。右键或 Shift+F10 打开标签页操作菜单。</span></div>
    <section className="document-panel" id="document-panel" role={current ? 'tabpanel' : undefined} aria-labelledby={current ? `file-tab-${workspace.list().findIndex((session) => session.path === activePath)}` : undefined}>
      {current && <div className="document-toolbar"><div className="breadcrumb"><span>工作区</span><ChevronRight size={13} /><span title={current.path}>{current.path}</span></div><div className="document-actions">
        {current.viewer === 'markdown' && <div className="mode-switch" role="group" aria-label="编辑模式"><Button title="切换保留正文，撤销历史可能重置" aria-pressed={current.mode === 'rich'} onClick={() => workspace.setMode(current.path, 'rich')}><BookOpen size={14} />富文本</Button><Button title="切换保留正文，撤销历史可能重置" aria-pressed={current.mode === 'source'} onClick={() => workspace.setMode(current.path, 'source')}><Braces size={14} />源码</Button></div>}
        {['markdown', 'text'].includes(current.viewer) && <Button size="icon" aria-label="保存当前文件" title="保存（Ctrl/Cmd+S）" disabled={current.locked || current.state === 'saving' || current.state === 'conflict' || !current.dirty || !!current.external} onClick={() => void workspace.save(current.path)}><Save size={16} /></Button>}{['markdown', 'text'].includes(current.viewer) ? <Button size="icon" aria-label="下载当前草稿" title="下载当前草稿" onClick={() => downloadDraft(current.path, current.source)}><ArrowDownToLine size={16} /></Button> : <a className="button button-icon" href={fileURL(current.path)} download aria-label="下载文件"><ArrowDownToLine size={16} /></a>}
      </div></div>}
      <UploadFailures busy={uploading} onDiscard={setDiscardUpload} onRetry={(entries) => void uploadAttachments(entries.map((entry) => entry.file), entries)} />
      {notice && <div className="notice" role="status"><Info size={16} /><span>{notice}</span><Button size="icon" aria-label="关闭提示" onClick={() => setNotice('')}><X size={14} /></Button></div>}
      {recovery.warning && <div className="notice save-error" role="alert"><Info size={16} /><span>{recovery.warning}</span><Button onClick={() => void manager.retry().catch(() => {})}>重试本地存储</Button></div>}
      {external.warning && <div className="notice" role="status"><Info size={16} /><span>{external.warning}</span><Button disabled={external.checking} onClick={() => void external.check()}>重新检查</Button></div>}
      {current?.external && !current.dirty && <div className="notice" role="status"><Info size={16} /><span>{current.external === 'missing' ? '磁盘文件已被移走或删除，当前显示缓存内容。可下载草稿或另存副本。' : '磁盘文件已发生变化，当前显示旧版本。重新加载会重置撤销历史。'}</span>{current.external === 'changed' && <Button variant="outline" onClick={() => void reloadCurrent()}>加载磁盘版本</Button>}{['markdown', 'text'].includes(current.viewer) && <Button onClick={() => void loadComparison()}>比较并另存</Button>}</div>}
      {current && ['error', 'conflict'].includes(current.state) && <div className="notice save-error" role="alert"><Info size={16} /><span>{current.error}</span>{current.state === 'conflict' ? <Button variant="outline" onClick={() => void loadComparison()}>比较版本</Button> : <Button variant="outline" onClick={() => void workspace.save(current.path)}>重试保存</Button>}</div>}
      {loading ? <div className="editor-loading" role="status">正在读取文件…</div> : current ? <div className="editor-scroll" inert={current.locked} key={current.path + current.mode + current.generation + editorAttempt}><EditorBoundary retry={() => { workspace.setMode(current.path, 'source'); setEditorAttempt((value) => value + 1) }}><Suspense fallback={<div className="editor-loading">正在加载编辑器…</div>}><DocumentEditor navigationOpen={navigationOpen} session={current} sessions={workspace} onBlocked={onBlocked} bridge={bridge} searchTarget={searchTarget} onSearchLocated={onSearchLocated} /></Suspense></EditorBoundary></div> : <div className="empty-workspace"><FileText size={28} strokeWidth={1.3} /><h1>为想法留一个位置</h1><p>从左侧打开文件，或写下第一篇笔记。</p><Button variant="outline" onClick={() => startCreate('file')}><FilePlus2 size={15} />新建笔记</Button></div>}
    </section></main></div>
    <footer className="statusbar" aria-label="编辑状态">
      <div className="statusbar-left"><span className="save-status" role="status">{current ? current.external && !current.dirty ? '磁盘版本已变化' : current.locked ? '正在处理文件操作…' : current.pendingUploads ? '正在上传图片…' : ['markdown', 'text'].includes(current.viewer) ? saveLabels[current.state] : '只读预览' : ''}</span><span className="draft-cache-state" data-phase={current?.dirty ? recovery.phase : undefined}>{current?.dirty && ['markdown', 'text'].includes(current.viewer) ? recovery.phase === 'ready' ? '本机恢复副本已更新' : recovery.phase === 'failed' ? '本机恢复副本不可用' : '正在更新本机恢复副本…' : ''}</span></div>
      {current && <FileStatus session={current} onSearch={() => setSearchOpen(true)} />}
      <Button className="draft-recovery-trigger" aria-label="查看浏览器恢复稿" title="查看浏览器中保留的未保存草稿" onClick={() => setRecoveryOpen(true)}><History size={13} /><span className="recovery-label">浏览器恢复稿</span><span className="recovery-count">{recovery.entries.length || ''}</span></Button>
    </footer>

    <Dialog.Root open={!!discardUpload} onOpenChange={(value) => { if (!value) setDiscardUpload(undefined) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content"><Dialog.Title>移除待上传原件？</Dialog.Title><Dialog.Description>「{discardUpload?.file.name}」移除后将不再由当前页面保留。请先确认已上传或已下载原件；此操作不会删除服务器文件。</Dialog.Description><div className="dialog-actions"><Button onClick={() => setDiscardUpload(undefined)}>取消</Button><Button variant="outline" onClick={() => { if (discardUpload) uploadQueue.remove(discardUpload.id); setDiscardUpload(undefined) }}>确认移除原件</Button></div></DialogContent></Dialog.Portal></Dialog.Root>
    <DraftRecovery manager={manager} open={recoveryOpen} onOpenChange={setRecoveryOpen} onNotice={onBlocked} onOpen={(path) => { void client.invalidateQueries({ queryKey: ['tree'] }); void openFile(path) }} />
    {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} onOpen={(path, query, contentMatch) => { const id = ++searchSequence.current; setSearchTarget(undefined); setFocusPath(path); void client.invalidateQueries({ queryKey: ['tree'] }); void openFile(path).then(() => { if (id !== searchSequence.current) return; if (useUI.getState().activePath !== path) { setFocusPath(null); return }; if (query.trim()) setSearchTarget({ id, path, query, contentMatch }) }) }} />}
    <Dialog.Root open={shortcutsOpen} onOpenChange={setShortcutsOpen}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content"><Dialog.Title>工作区快捷键</Dialog.Title><Dialog.Description>编辑时可使用以下按键，也可通过工具栏和文件菜单完成操作。</Dialog.Description>
      <dl className="shortcut-list"><div><dt>保存当前文件</dt><dd>Ctrl / Cmd + S</dd></div><div><dt>搜索</dt><dd>Ctrl / Cmd + P 或 Ctrl / Cmd + Shift + F</dd></div><div><dt>上一个 / 下一个标签</dt><dd>Alt + PageUp / PageDown</dd></div><div><dt>保存并关闭当前标签</dt><dd>Ctrl / Cmd + Alt + W</dd></div><div><dt>切换文件列表</dt><dd>Ctrl / Cmd + B</dd></div><div><dt>浏览目录</dt><dd>↑ ↓ ← → / Home / End</dd></div><div><dt>重命名 / 删除确认</dt><dd>F2 / Delete</dd></div><div><dt>文件操作菜单</dt><dd>Shift + F10</dd></div></dl><p>加粗快捷键在编辑器内保留。在编辑器中先按 Escape，再按 Tab / Shift+Tab 可移出焦点；在文件标签上按 Delete 可保存并关闭。浏览器的 Ctrl / Cmd + W 和 Ctrl + Tab 仍由浏览器处理；窗口管理器也可能占用部分按键。</p><div className="dialog-actions"><Dialog.Close asChild><Button variant="outline">关闭</Button></Dialog.Close></div>
    </DialogContent></Dialog.Portal></Dialog.Root>
    {operations.dialogs}<TrashDialog open={trashOpen} onOpenChange={setTrashOpen} />
    <Dialog.Root open={createKind !== null} onOpenChange={(value) => { if (!value && !busy) setCreateKind(null) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content">
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
    </DialogContent></Dialog.Portal></Dialog.Root>

    <Dialog.Root open={!!comparison} onOpenChange={(value) => { if (!value) closeComparison() }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content conflict-dialog"><Dialog.Title>文件版本发生冲突</Dialog.Title><Dialog.Description>本地草稿与磁盘版本均已保留。关闭窗口不会覆盖任意版本。{comparison?.path}</Dialog.Description>
      <div className="compare-columns"><div><label htmlFor="comparison-local">本地草稿</label><textarea id="comparison-local" readOnly value={comparison?.session.source ?? ''} /></div><div><label htmlFor="comparison-remote">磁盘版本</label><textarea id="comparison-remote" readOnly value={remote?.content ?? (comparisonLoading ? '正在读取磁盘版本…' : '磁盘正文不可读；仍可另存本地草稿。')} /></div></div>
      {comparisonError && <p className="form-error" role="alert">{comparisonError}</p>}
      <label htmlFor="copy-path">副本路径</label><input id="copy-path" value={copyPath} onChange={(event) => setCopyPath(event.target.value)} disabled={busy} /><p className="small-label">输入工作区相对路径。原目录已不存在时，请选择仍存在的目录；已有同名文件不会被覆盖。</p>
      <div className="dialog-actions"><Button onClick={() => comparison && downloadDraft(comparison.path, comparison.session.source)}>下载本地草稿</Button><Button variant="outline" disabled={comparisonLoading || busy || !copyPath.trim()} onClick={() => void handleKeepSeparate()}>{busy ? '正在保存副本…' : remote ? '保留本地副本并加载磁盘版本' : '另存本地副本'}</Button><Button onClick={closeComparison} disabled={busy}>稍后处理</Button></div>
    </DialogContent></Dialog.Portal></Dialog.Root>
  </div>
}
