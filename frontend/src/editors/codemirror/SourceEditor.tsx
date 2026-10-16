import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { codeTheme } from '../theme'
import type { Session, WorkspaceSessions } from '../../sessions/workspace'
import type { CrepeBridge } from '../milkdown/bridge'
import { imageMarkdown } from '../milkdown/bridge'
import { preserveLineEndings } from './line-endings'

export default function SourceEditor({ session, sessions, onBlocked, bridge }: { session: Session; sessions: WorkspaceSessions; onBlocked?: (message: string) => void; bridge?: CrepeBridge }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let disposed = false
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
      extensions: [lineNumbers(), highlightSpecialChars(), drawSelection(), history(), bracketMatching(), highlightActiveLine(),
        lineEndings.extension, codeTheme, keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]), language.of([]), EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': '源码编辑器', 'aria-multiline': 'true', 'aria-description': '按 Escape 后再按 Tab 或 Shift+Tab 离开编辑器。' }),
        EditorView.domEventHandlers({ paste: (event, view) => handleFiles(event, view, event.clipboardData?.files), drop: (event, view) => handleFiles(event, view, event.dataTransfer?.files) }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            for (const [id, position] of uploads) uploads.set(id, update.changes.mapPos(position))
            sessions.update(session.path, lineEndings.serialize(update.state))
          }
        }),
      ],
    }) })
    const description = LanguageDescription.matchFilename(languages, session.path)
    if (description) void description.load().then((support) => { if (!disposed) view.dispatch({ effects: language.reconfigure(support) }) }).catch(() => onBlocked?.('语言高亮加载失败，当前仍可编辑纯文本。'))
    return () => { disposed = true; view.destroy() }
  }, [session, sessions, onBlocked, bridge])
  return <div className="source-host" ref={host} />
}
