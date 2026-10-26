import { clearSourceChangeMarks, sourceChangeMarks } from '../changes/source'
import { entryMime, hasEntryTransfer, readEntryTransfer } from '../../features/explorer/entry-transfer'
import { markdownLinkAt } from './links'
import { SourceNavigation } from '../navigation/SourceNavigation'
import { literalRange } from '../../features/search/location'
import type { SearchTarget, SearchLocated } from '../../features/search/location'
import { useEffect, useRef, useState } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightSpecialChars, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { codeTheme } from '../theme'
import type { Session, WorkspaceSessions } from '../../sessions/workspace'
import type { CrepeBridge } from '../milkdown/bridge'
import { imageMarkdown, referenceMarkdown } from '../milkdown/bridge'
import { preserveLineEndings } from './line-endings'

export default function SourceEditor({ session, sessions, onBlocked, bridge, searchTarget, onSearchLocated, navigationOpen }: { navigationOpen?: boolean; session: Session; sessions: WorkspaceSessions; onBlocked?: (message: string) => void; bridge?: CrepeBridge; searchTarget?: SearchTarget; onSearchLocated?: SearchLocated }) {
  const [navigationView, setNavigationView] = useState<EditorView | null>(null)
  const editorView = useRef<EditorView | null>(null)
  const restoreFrame = useRef<number | null>(null)
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!session.externalUpdate) editorView.current?.dispatch({ effects: clearSourceChangeMarks.of() })
  }, [session.externalUpdate])
  useEffect(() => {
    let disposed = false
    const generation = session.generation
    const lineEndings = preserveLineEndings(session.source)
    const language = new Compartment()
    const uploads = new Map<symbol, number>()
    const handleFiles = (event: ClipboardEvent | DragEvent, view: EditorView, files?: FileList) => {
      if (!bridge || !files?.length) return false
      event.preventDefault()
      const position = event instanceof DragEvent ? view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head : view.state.selection.main.head
      for (const file of Array.from(files)) {
        if (!bridge.beginUpload()) { onBlocked?.('文件操作正在进行，请稍后再粘贴图片。'); continue }
        const id = Symbol('图片上传'); uploads.set(id, position)
        void bridge.upload(file).then((url) => {
          if (disposed) { bridge.detachedImage(url, file.name); return }
          const position = uploads.get(id) ?? view.state.doc.length
          view.dispatch({ changes: { from: position, insert: imageMarkdown(url, file.name) } })
        }).catch((error: unknown) => onBlocked?.(error instanceof Error ? error.message : '图片上传失败，原文已保留'))
          .finally(() => { uploads.delete(id); bridge.endUpload() })
      }
      return true
    }
    const view = new EditorView({ parent: host.current!, state: EditorState.create({
      doc: lineEndings.doc,
      extensions: [sourceChangeMarks(session.externalUpdate), lineNumbers(), highlightSpecialChars(), drawSelection(), history(), bracketMatching(),
        lineEndings.extension, codeTheme, keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]), language.of([]), EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': '源码编辑器', 'aria-multiline': 'true', 'aria-description': '按 Escape 后再按 Tab 或 Shift+Tab 离开编辑器。' }),
        EditorView.domEventHandlers({
          mousedown: (event, view) => {
            if (!bridge || event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false
            const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
            const href = position === null ? undefined : markdownLinkAt(view.state.doc.toString(), position)
            if (!href) return false
            event.preventDefault(); bridge.openLink(href); return true
          }, dragover: (event) => {
            if (!bridge || !hasEntryTransfer(event.dataTransfer)) return false
            event.preventDefault(); event.dataTransfer!.dropEffect = 'copy'; return true
          }, paste: (event, view) => handleFiles(event, view, event.clipboardData?.files), drop: (event, view) => {
            if (bridge && event.dataTransfer?.types.includes(entryMime)) {
              event.preventDefault()
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
          if (update.docChanged || update.viewportChanged || update.selectionSet) update.view.dom.dispatchEvent(new Event('folio-navigation'))
          if (update.docChanged) {
            for (const [id, position] of uploads) uploads.set(id, update.changes.mapPos(position))
            if (!disposed && session.generation === generation) sessions.update(session.path, lineEndings.serialize(update.state))
          }
        }),
      ],
    }) })
    view.scrollDOM.tabIndex = 0
    view.scrollDOM.setAttribute('aria-label', '源码滚动区域')
    if (session.sourceView) {
      const saved = session.sourceView
      view.dispatch({ selection: { anchor: Math.min(saved.anchor, view.state.doc.length), head: Math.min(saved.head, view.state.doc.length) } })
      restoreFrame.current = requestAnimationFrame(() => { restoreFrame.current = null; if (!disposed) { view.scrollDOM.scrollTop = saved.scrollTop; view.scrollDOM.scrollLeft = saved.scrollLeft } })
    }
    editorView.current = view
    setNavigationView(view)
    const description = LanguageDescription.matchFilename(languages, session.path)
    if (description) void description.load().then((support) => { if (!disposed) view.dispatch({ effects: language.reconfigure(support) }) }).catch(() => onBlocked?.('语言高亮加载失败，当前仍可编辑纯文本。'))
    return () => { disposed = true; if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current); restoreFrame.current = null; session.sourceView = { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft }; editorView.current = null; view.destroy() }
  }, [session, sessions, onBlocked, bridge])
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
  return <div className="editor-with-navigation"><div className="source-host" ref={host} />{navigationOpen && navigationView && <SourceNavigation view={navigationView} markdown={session.viewer === 'markdown'} />}</div>
}
