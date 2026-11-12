import { EditorSelection } from '@codemirror/state'
import { EditorView, type Command, type KeyBinding } from '@codemirror/view'

function writable(view: EditorView) { return !view.state.readOnly && view.state.facet(EditorView.editable) }
function delimit(before: string, after = before): Command {
  return view => {
    if (!writable(view)) return true
    const { state } = view, range = state.selection.main
    const selected = state.sliceDoc(range.from, range.to)
    const following = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + after.length))
    if (selected.length >= before.length + after.length && selected.startsWith(before) && selected.endsWith(after)) {
      const text = selected.slice(before.length, -after.length)
      view.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: EditorSelection.range(range.from, range.from + text.length), userEvent: 'input.format' })
    } else if (state.sliceDoc(Math.max(0, range.from - before.length), range.from) === before && following === after) {
      view.dispatch({ changes: [{ from: range.from - before.length, to: range.from }, { from: range.to, to: range.to + after.length }], selection: EditorSelection.range(range.from - before.length, range.to - before.length), userEvent: 'input.format' })
    } else if (range.empty && following === after) {
      view.dispatch({ selection: { anchor: range.to + after.length } })
    } else {
      view.dispatch({ changes: { from: range.from, to: range.to, insert: before + selected + after }, selection: EditorSelection.range(range.from + before.length, range.to + before.length), userEvent: 'input.format' })
    }
    view.focus(); return true
  }
}
function prefixLines(prefix: string): Command {
  return view => {
    if (!writable(view)) return true
    const { state } = view, selection = state.selection.main
    const first = state.doc.lineAt(selection.from), last = state.doc.lineAt(selection.to > selection.from && state.doc.lineAt(selection.to).from === selection.to ? selection.to - 1 : selection.to)
    const lines = Array.from({ length: last.number - first.number + 1 }, (_, index) => state.doc.line(first.number + index))
    const remove = lines.every(line => line.text.startsWith(prefix))
    const changes = state.changes(lines.map(line => ({ from: line.from, to: line.from + (remove ? prefix.length : 0), insert: remove ? '' : prefix })))
    view.dispatch({ changes, selection: state.selection.map(changes), userEvent: 'input.format' })
    view.focus(); return true
  }
}
const insertLink: Command = view => {
  if (!writable(view)) return true
  const range = view.state.selection.main, label = view.state.sliceDoc(range.from, range.to)
  view.dispatch({ changes: { from: range.from, to: range.to, insert: `[${label}]()` }, selection: { anchor: range.from + (label ? label.length + 3 : 1) }, userEvent: 'input.format' })
  view.focus(); return true
}

export const markdownCommands = {
  bold: delimit('**'), italic: delimit('*'), code: delimit('`'), strike: delimit('~~'), link: insertLink,
  quote: prefixLines('> '), bullet: prefixLines('- '), task: prefixLines('- [ ] '),
} satisfies Record<string, Command>
export const markdownFormatKeymap: readonly KeyBinding[] = [
  { key: 'Mod-b', run: markdownCommands.bold }, { key: 'Mod-i', run: markdownCommands.italic },
  { key: 'Mod-Shift-x', run: markdownCommands.strike }, { key: 'Mod-k', run: markdownCommands.link },
  { key: 'Mod-Alt-8', run: markdownCommands.bullet }, { key: 'Mod-Alt-9', run: markdownCommands.quote },
]
