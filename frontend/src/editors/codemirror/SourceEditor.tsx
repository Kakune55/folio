import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching } from '@codemirror/language'
import { codeTheme } from '../theme'
import { markdown } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import type { Session, WorkspaceSessions } from '../../sessions/workspace'

export default function SourceEditor({ session, sessions }: { session: Session; sessions: WorkspaceSessions }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: EditorState.create({
      doc: session.source,
      extensions: [lineNumbers(), highlightSpecialChars(), drawSelection(), history(), bracketMatching(), highlightActiveLine(),
        codeTheme, keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        session.path.endsWith('.json') ? json() : markdown(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': '源码编辑器', 'aria-multiline': 'true' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) sessions.update(session.path, update.state.doc.toString())
        }),
      ],
    }) })
    return () => view.destroy()
  }, [session, sessions])
  return <div className="source-host" ref={host} />
}
