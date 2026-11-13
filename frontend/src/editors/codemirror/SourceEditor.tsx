import { clearSourceChangeMarks, sourceChangeMarks } from '../changes/source'
import { entryMime, hasEntryTransfer, readEntryTransfer } from '../../features/explorer/entry-transfer'
import { markdownLinkAt } from './links'
import { SourceNavigation } from '../navigation/SourceNavigation'
import { literalRange } from '../../features/search/location'
import type { SearchTarget, SearchLocated } from '../../features/search/location'
import { useEffect, useRef, useState } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightSpecialChars, drawSelection, dropCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { markdown, commonmarkLanguage } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { codeTheme } from '../theme'
import type { Session, WorkspaceSessions } from '../../sessions/workspace'
import type { EditorBridge } from '../bridge'
import { imageMarkdown, referenceMarkdown, resolveFileLink } from '../bridge'
import { preserveLineEndings } from './line-endings'
import { markdownLivePreview } from './live-preview'
import { markdownPreviewBlocks } from './preview-blocks'
import { codeBlockControls } from './code-blocks'
import { createCodeLanguages } from './code-languages'
import { TableControls } from './TableControls'
import { focusTableCell, type TableWidgetOptions } from './table-widget'
import { mathMarkdown } from './math-syntax'
import { markdownMathPreview } from './math-preview'
import { tableNavigation } from './tables'
import { markdownCommands, markdownFormatKeymap } from './markdown-commands'
import { Bold, Italic, Code, Link2, List, ListTodo, Quote } from 'lucide-react'
import { Button } from '../../components/ui/button'

const formats = [
  { label: '加粗', icon: Bold, run: markdownCommands.bold }, { label: '斜体', icon: Italic, run: markdownCommands.italic },
  { label: '行内代码', icon: Code, run: markdownCommands.code }, { label: '插入链接', icon: Link2, run: markdownCommands.link },
  { label: '无序列表', icon: List, run: markdownCommands.bullet }, { label: '任务列表', icon: ListTodo, run: markdownCommands.task },
  { label: '引用', icon: Quote, run: markdownCommands.quote },
]
const editorAttributes = (preview: boolean) => EditorView.contentAttributes.of({ 'aria-label': preview ? 'Markdown 编辑器' : '源码编辑器', 'aria-multiline': 'true', 'aria-description': '按 Escape 后再按 Tab 或 Shift+Tab 离开编辑器。' })
function tableNavigationKeys(options: { canEdit: () => boolean; onBoundary: () => void; onBlocked?: (message: string) => void }) {
  const navigate = (backward: boolean) => (view: EditorView) => {
    if (view.composing || view.compositionStarted) return false
    const result = tableNavigation(view.state, backward)
    if (!result) return false
    if (!options.canEdit() || view.state.readOnly || !view.state.facet(EditorView.editable)) { options.onBlocked?.('当前不能编辑表格，请先处理未确认输入或文件操作。'); return true }
    if ('error' in result) { options.onBlocked?.(result.error); return true }
    if ('boundary' in result) { options.onBoundary(); return true }
    view.dispatch(result); return true
  }
  return keymap.of([{ key: 'Tab', run: navigate(false) }, { key: 'Shift-Tab', run: navigate(true) }])
}

export default function SourceEditor({ session, sessions, onBlocked, bridge, searchTarget, onSearchLocated, navigationOpen, formatbarVisible = true }: { navigationOpen?: boolean; formatbarVisible?: boolean; session: Session; sessions: WorkspaceSessions; onBlocked?: (message: string) => void; bridge?: EditorBridge; searchTarget?: SearchTarget; onSearchLocated?: SearchLocated }) {
  const [navigationView, setNavigationView] = useState<EditorView | null>(null)
  const editorView = useRef<EditorView | null>(null)
  const restoreFrame = useRef<number | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const preview = useRef(new Compartment()), editable = useRef(new Compartment())
  const displayedMode = useRef(session.mode)
  const codeControls = useRef<Extension>([])
  const cellOptions = useRef<TableWidgetOptions>({})
  const isMarkdown = session.viewer === 'markdown'
  useEffect(() => {
    if (!session.externalUpdate) editorView.current?.dispatch({ effects: clearSourceChangeMarks.of() })
  }, [session.externalUpdate])
  useEffect(() => {
    let disposed = false
    let compositionTimer: ReturnType<typeof setTimeout> | undefined
    const generation = session.generation
    const path = session.path
    const current = () => sessions.has(path) && sessions.get(path) === session && session.path === path && session.generation === generation
    const canEdit = () => !disposed && current() && !session.locked && !sessions.isLocked(path)
    const canEditWidget = () => canEdit() && !session.composing && !session.compositionInterrupted
    const lineEndings = preserveLineEndings(session.source)
    const codeLanguages = createCodeLanguages(name => {
      if (!disposed) onBlocked?.(`${name} 语法高亮加载失败，原文仍可编辑和复制；请保存或下载草稿后刷新页面重试。`)
    })
    codeControls.current = codeBlockControls({ slice: lineEndings.slice, onBlocked })
    const finishComposition = (view: EditorView) => {
      clearTimeout(compositionTimer)
      const deadline = performance.now() + 1000
      const finish = () => {
        if (disposed || !current()) return
        if (view.composing || view.compositionStarted) {
          if (performance.now() < deadline) { compositionTimer = setTimeout(finish, 30); return }
          sessions.setComposing(path, false, true)
          return
        }
        sessions.setComposing(path, false)
      }
      compositionTimer = setTimeout(finish, 30)
    }
    const language = new Compartment()
    const uploads = new Map<symbol, number>()
    const handleFiles = (event: ClipboardEvent | DragEvent, view: EditorView, files?: FileList) => {
      if (!bridge || !files?.length) return false
      event.preventDefault()
      if (!canEdit()) { onBlocked?.('文件正在处理或已切换，请稍后再上传。'); return true }
      const position = event instanceof DragEvent ? view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head : view.state.selection.main.head
      for (const file of Array.from(files)) {
        if (!bridge.beginUpload()) { onBlocked?.('文件操作正在进行，请稍后再粘贴图片。'); continue }
        const id = Symbol('图片上传'); uploads.set(id, position)
        void bridge.upload(file).then((url) => {
          if (session.composing || session.compositionInterrupted) {
            let location = url
            try { location = resolveFileLink(path, url) } catch { /* 保留上传位置供手动恢复。 */ }
            onBlocked?.(`图片已上传到「${location}」，输入法候选尚未确认，未自动插入；请确认后从文件列表插入。`)
            return
          }
          if (disposed || !canEdit()) {
            if (current() && !session.locked && !sessions.isLocked(path)) bridge.detachedImage(url, file.name)
            else {
              let location = url
              try { location = resolveFileLink(path, url) } catch { /* 保留服务端返回的已上传位置供恢复。 */ }
              onBlocked?.(`图片已上传到「${location}」，原笔记上下文已变化，未自动插入；请从文件列表重新插入。`)
            }
            return
          }
          const position = uploads.get(id) ?? view.state.doc.length
          view.dispatch({ changes: { from: position, insert: imageMarkdown(url, file.name) } })
        }).catch((error: unknown) => onBlocked?.(error instanceof Error ? error.message : '图片上传失败，原文已保留'))
          .finally(() => { uploads.delete(id); bridge.endUpload() })
      }
      return true
    }
    cellOptions.current = {
      canEdit: canEditWidget,
      canEditCell: () => canEdit() && !session.compositionInterrupted,
      onBlocked,
      onCellComposition: (active, view, interrupted) => {
        if (!current()) return
        if (active) { clearTimeout(compositionTimer); sessions.setComposing(path, true) }
        else if (interrupted) { clearTimeout(compositionTimer); sessions.setComposing(path, false, true) }
        else finishComposition(view)
      },
    }
    const rendering = () => [editorAttributes(isMarkdown && session.mode === 'rich'), ...(isMarkdown && session.mode === 'rich'
      ? [markdownLivePreview({ canEdit: canEditWidget, onBlocked }), markdownPreviewBlocks({ ...cellOptions.current, bridge, revealTables: () => !!session.externalUpdate }), markdownMathPreview({ revealSource: () => !!session.externalUpdate, canReveal: () => !session.composing && !session.compositionInterrupted, onBlocked }), codeControls.current] : [])]
    displayedMode.current = session.mode
    const view = new EditorView({ parent: host.current!, state: EditorState.create({
      doc: lineEndings.doc,
      extensions: [sourceChangeMarks(session.externalUpdate), lineNumbers(), highlightSpecialChars(), drawSelection(), dropCursor(), history(), bracketMatching(),
        lineEndings.extension, codeTheme, isMarkdown ? [tableNavigationKeys({ canEdit: canEditWidget, onBlocked, onBoundary: () => host.current?.parentElement?.querySelector<HTMLButtonElement>('[data-table-trigger]')?.focus() }), keymap.of(markdownFormatKeymap)] : [], keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]), language.of([]), EditorView.lineWrapping,
        preview.current.of(rendering()),
        editable.current.of([EditorState.readOnly.of(session.locked), EditorView.editable.of(!session.locked)]),
        EditorState.transactionFilter.of(transaction => {
          if (!transaction.docChanged) return transaction
          if (!canEdit()) { queueMicrotask(() => onBlocked?.('文件正在处理，暂不能修改；当前正文已保留。')); return [] }
          try { lineEndings.serialize(transaction.state); return transaction }
          catch (error) { queueMicrotask(() => onBlocked?.(error instanceof Error ? error.message : '原始字节映射校验失败，未应用编辑。')); return [] }
        }),
        EditorView.domEventHandlers({
          focus: (_event, view) => { queueMicrotask(() => { if (!disposed && view.hasFocus) focusTableCell(view) }) },
          compositionstart: () => { if (canEdit()) sessions.setComposing(path, true) },
          compositionend: (_event, view) => finishComposition(view),
          blur: (_event, view) => { if (session.composing) finishComposition(view) },
          mousedown: (event, view) => {
            if (!bridge || event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
            const href = position === null ? undefined : markdownLinkAt(view.state.doc.toString(), position)
            if (!href) return false
            event.preventDefault(); bridge.openLink(href); return true
          }, dragover: (event) => {
            if (!bridge || !hasEntryTransfer(event.dataTransfer)) return false
            event.preventDefault(); event.dataTransfer!.dropEffect = 'copy'; return true
          }, paste: (event, view) => {
            if (handleFiles(event, view, event.clipboardData?.files)) return true
            const text = event.clipboardData?.getData('text/plain')
            if (!text) {
              if (event.clipboardData?.getData('text/html')) { event.preventDefault(); onBlocked?.('剪贴板只有富 HTML，未自动转换；请使用纯文本粘贴。'); return true }
              return false
            }
            event.preventDefault()
            if (!canEdit()) return true
            try { view.dispatch(lineEndings.paste(view.state, text)) }
            catch (error) { onBlocked?.(error instanceof Error ? error.message : '粘贴失败，原文已保留。') }
            return true
          }, drop: (event, view) => {
            if (bridge && event.dataTransfer?.types.includes(entryMime)) {
              event.preventDefault()
              if (!canEdit()) return true
              const entry = readEntryTransfer(event.dataTransfer)
              const reference = entry && bridge.reference(entry)
              if (reference) {
                const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
                view.dispatch({ changes: { from: position, insert: referenceMarkdown(reference) } }); view.focus()
              }
              return true
            }
            return handleFiles(event, view, event.dataTransfer?.files)
          } }),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet && update.view.hasFocus) queueMicrotask(() => { if (!disposed && update.view.hasFocus) focusTableCell(update.view) })
          if (update.docChanged || update.viewportChanged || update.selectionSet) update.view.dom.dispatchEvent(new Event('folio-navigation'))
          if (update.docChanged) {
            for (const [id, position] of uploads) uploads.set(id, update.changes.mapPos(position))
            if (!disposed && current()) {
              if (update.view.composing || update.view.compositionStarted) sessions.setComposing(path, true)
              sessions.update(session.path, lineEndings.serialize(update.state))
            }
          }
        }),
      ],
    }) })
    view.scrollDOM.tabIndex = 0
    view.scrollDOM.setAttribute('aria-label', '编辑器滚动区域')
    if (session.sourceView) {
      const saved = session.sourceView
      view.dispatch({ selection: { anchor: Math.min(saved.anchor, view.state.doc.length), head: Math.min(saved.head, view.state.doc.length) } })
      restoreFrame.current = requestAnimationFrame(() => { restoreFrame.current = null; if (!disposed) { view.scrollDOM.scrollTop = saved.scrollTop; view.scrollDOM.scrollLeft = saved.scrollLeft } })
    }
    editorView.current = view
    setNavigationView(view)
    if (session.viewer === 'markdown') view.dispatch({ effects: language.reconfigure(markdown({ base: commonmarkLanguage, extensions: [GFM, mathMarkdown], codeLanguages, pasteURLAsLink: false })) })
    else {
      const description = LanguageDescription.matchFilename(languages, session.path)
      if (description) void description.load().then((support) => { if (!disposed) view.dispatch({ effects: language.reconfigure(support) }) }).catch(() => onBlocked?.('语言高亮加载失败，当前仍可编辑纯文本。'))
    }
    return () => {
      disposed = true; clearTimeout(compositionTimer)
      if (sessions.has(session.path) && sessions.get(session.path) === session && session.composing) sessions.setComposing(session.path, false, true)
      if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current)
      restoreFrame.current = null
      session.sourceView = { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft }
      editorView.current = null; view.destroy()
    }
  }, [session, sessions, onBlocked, bridge, isMarkdown])
  useEffect(() => {
    const view = editorView.current
    if (!view || displayedMode.current === session.mode) return
    displayedMode.current = session.mode
    const canEdit = () => !session.composing && !session.compositionInterrupted && !session.locked && !sessions.isLocked(session.path)
    view.dispatch({ effects: preview.current.reconfigure([editorAttributes(isMarkdown && session.mode === 'rich'), ...(isMarkdown && session.mode === 'rich'
      ? [markdownLivePreview({ canEdit, onBlocked }), markdownPreviewBlocks({ ...cellOptions.current, bridge, revealTables: () => !!session.externalUpdate }), markdownMathPreview({ revealSource: () => !!session.externalUpdate, canReveal: () => !session.composing && !session.compositionInterrupted, onBlocked }), codeControls.current] : [])]) })
    view.requestMeasure()
  }, [session.mode, isMarkdown, session, sessions, bridge, onBlocked])
  useEffect(() => {
    editorView.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(session.locked), EditorView.editable.of(!session.locked)]) })
  }, [session.locked, session.composing, session.compositionInterrupted])
  useEffect(() => {
    const view = editorView.current
    if (!view || !searchTarget || searchTarget.path !== session.path || session.locked) return
    const range = literalRange(view.state.doc.toString(), searchTarget.query)
    if (range) {
      // 显式搜索导航优先，不能再被初始化的延迟滚动恢复覆盖。
      if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current)
      restoreFrame.current = null
      view.dispatch({ selection: { anchor: range.from, head: range.to }, effects: EditorView.scrollIntoView(range.from, { y: 'center' }) })
      view.focus()
    }
    onSearchLocated?.(searchTarget, !!range)
  }, [searchTarget, onSearchLocated, session, session.locked])
  return <div className="editor-with-navigation"><div className="editor-content-column">{isMarkdown && formatbarVisible && <div id={`formatbar-${session.id}`} className="editor-formatbar" role="toolbar" aria-label="Markdown 格式">{formats.map(({ label, icon: Icon, run }) => <Button key={label} size="icon" aria-label={label} title={label} disabled={session.locked || session.composing} onMouseDown={event => event.preventDefault()} onClick={() => { if (editorView.current) run(editorView.current) }}><Icon size={15} /></Button>)}<TableControls view={navigationView} disabled={!!(session.locked || session.composing || session.compositionInterrupted)} onBlocked={onBlocked} /></div>}<div className={`source-host ${isMarkdown ? 'markdown-host' : ''} ${isMarkdown && session.mode === 'rich' ? 'live-preview-host' : ''}`} data-mode={isMarkdown ? session.mode : 'source'} ref={host} /></div>{navigationOpen && navigationView && <SourceNavigation view={navigationView} markdown={isMarkdown} />}</div>
}
