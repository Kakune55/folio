import { DialogContent } from '../components/ui/dialog-content'
import { Component, lazy, Suspense, useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowDownToLine, ChevronRight, FileJson2, FileText, FolderOpen, Info, Monitor, Moon, PanelLeft, Sun, X, Braces, BookOpen } from 'lucide-react'
import { Button } from '../components/ui/button'
import { workspace } from '../sessions/demo'
import { useUI } from '../stores/ui'
import { useState } from 'react'

const RichEditor = lazy(() => import('../editors/milkdown/RichEditor'))
const SourceEditor = lazy(() => import('../editors/codemirror/SourceEditor'))

class EditorBoundary extends Component<{ children: ReactNode; fallback: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info) }
  render() {
    return this.state.failed ? <div className="editor-error" role="alert"><p>编辑器加载失败，当前草稿仍保留在内存中。</p><Button variant="outline" onClick={this.props.fallback}>重新打开源码编辑器</Button></div> : this.props.children
  }
}

export default function App() {
  useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const { activePath, sidebar, theme, open, toggleSidebar, setTheme } = useUI()
  const session = workspace.get(activePath)
  const [notice, setNotice] = useState('')
  const [editorAttempt, setEditorAttempt] = useState(0)
  const onBlocked = useCallback((message: string) => setNotice(message), [])
  const isMarkdown = activePath.endsWith('.md')

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (workspace.list().some((file) => file.dirty)) event.preventDefault()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])
  const download = useCallback(() => {
    const current = workspace.get(useUI.getState().activePath)
    const url = URL.createObjectURL(new Blob([current.source], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = current.path
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice('已请求下载草稿。请确认浏览器完成下载；当前修改仍标记为未保存。')
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        download()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [download])

  const openFile = (path: string) => { setNotice(''); open(path) }
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon
  const themeLabel = theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'

  return <div className={`workbench ${sidebar ? '' : 'sidebar-hidden'}`}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">f</span><span>Folio</span><span className="workspace-name">个人工作区</span></div>
      <div className="topbar-actions"><span className="phase">M0 · 编辑器验证</span>
        <Button size="icon" aria-label={`主题：${themeLabel}`} title={`主题：${themeLabel}，点击切换`} onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}><ThemeIcon size={17} /></Button>
        <Dialog.Root><Dialog.Trigger asChild><Button size="icon" aria-label="关于当前版本" title="关于当前版本"><Info size={17} /></Button></Dialog.Trigger>
          <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content">
            <Dialog.Title>一处安静的文件工作区</Dialog.Title>
            <Dialog.Description>当前为 M0 可行性验证版本。两份示例文件仅驻留在页面内存中，尚未连接真实工作区。</Dialog.Description>
            <p>可以验证 Markdown、源码编辑与文件切换。检测到富文本转换差异时，先显示转换预览和 Diff；取消会保留原文并切回源码，明确确认才应用转换。</p>
            <p>切换文件或编辑模式会重置撤销历史，正文与未保存状态会保留。刷新或关闭页面会丢失内存草稿，请先下载。</p>
            <p>文件持久化、登录、上传和冲突处理属于 M1，搜索属于 M2。</p>
            <Dialog.Close asChild><Button className="dialog-close" size="icon" aria-label="关闭说明"><X size={17} /></Button></Dialog.Close>
          </DialogContent></Dialog.Portal>
        </Dialog.Root>
      </div>
    </header>
    <div className="workspace-body">
      <aside className="explorer" aria-label="文件资源管理器" inert={!sidebar}>
        <div className="explorer-heading"><span>文件</span><span className="subtle">2</span></div>
        <div className="folder-label"><ChevronRight size={14} className="expanded" /><FolderOpen size={16} /> 示例工作区</div>
        <nav aria-label="示例文件">{workspace.list().map((file) => <button key={file.path} className={`file-row ${activePath === file.path ? 'selected' : ''}`} onClick={() => openFile(file.path)} aria-current={activePath === file.path ? 'page' : undefined}>
          {file.path.endsWith('.md') ? <FileText size={16} /> : <FileJson2 size={16} />}<span>{file.path}</span>{file.dirty && <span className="dirty-dot" aria-label="未保存" />}
        </button>)}</nav>

      </aside>
      <main className="main-pane">
        <div className="tabs-row"><Button size="icon" aria-label={sidebar ? '收起文件列表' : '展开文件列表'} aria-expanded={sidebar} onClick={toggleSidebar}><PanelLeft size={16} /></Button>
          <div className="tabs" role="tablist" aria-label="打开的文件">{workspace.list().map((file, index, files) => <button id={`tab-${index}`} key={file.path} role="tab" aria-controls="document-panel" aria-selected={activePath === file.path} tabIndex={activePath === file.path ? 0 : -1} className={`tab ${activePath === file.path ? 'active' : ''}`} onClick={() => openFile(file.path)} onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? files.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + files.length) % files.length
            openFile(files[next].path)
            document.getElementById(`tab-${next}`)?.focus()
          }}>{file.path.endsWith('.md') ? <FileText size={14} /> : <Braces size={14} />}<span>{file.path}</span>{file.dirty && <span className="dirty-dot" aria-label="未保存" />}</button>)}</div>
        </div>
        <section className="document-panel" id="document-panel" role="tabpanel" aria-labelledby={`tab-${workspace.list().findIndex((file) => file.path === activePath)}`}>
          <div className="document-toolbar"><div className="breadcrumb"><span>示例工作区</span><ChevronRight size={13} /><span>{activePath}</span></div>
            <div className="document-actions">{isMarkdown && <div className="mode-switch" role="group" aria-label="编辑模式"><Button aria-pressed={session.mode === 'rich'} onClick={() => { setNotice(''); workspace.setMode(activePath, 'rich') }}><BookOpen size={14} /><span>富文本</span></Button><Button aria-pressed={session.mode === 'source'} onClick={() => { setNotice(''); workspace.setMode(activePath, 'source') }}><Braces size={14} /><span>源码</span></Button></div>}
              <Button size="icon" aria-label="下载当前草稿" title="下载当前草稿（Ctrl/Cmd+S）" onClick={download}><ArrowDownToLine size={16} /></Button>
            </div>
          </div>
          {notice && <div className="notice" role="status"><Info size={16} /><span>{notice}</span><Button size="icon" aria-label="关闭提示" onClick={() => setNotice('')}><X size={14} /></Button></div>}
          <div className="editor-scroll" key={activePath + session.mode + editorAttempt}>
            <EditorBoundary fallback={() => { workspace.setMode(activePath, 'source'); setEditorAttempt((value) => value + 1) }}>
              <Suspense fallback={<div className="editor-loading" role="status">正在加载编辑器…</div>}>
                {isMarkdown && session.mode === 'rich' ? <RichEditor session={session} sessions={workspace} onBlocked={onBlocked} /> : <SourceEditor session={session} sessions={workspace} />}
              </Suspense>
            </EditorBoundary>
          </div>
        </section>
      </main>
    </div>
    <footer className="statusbar"><span className="save-status" role="status">{session.dirty ? '● 未保存 · 仅本页内存' : '示例文件 · 仅本页内存'}</span><span className="history-hint">切换文件或模式保留正文，重置撤销历史</span><span>UTF-8<span className="status-divider">{isMarkdown ? 'Markdown' : 'JSON'}</span></span></footer>
  </div>
}
