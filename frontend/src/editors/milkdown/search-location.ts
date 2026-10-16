import { editorViewCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { Crepe } from '@milkdown/crepe'
import { literalRange } from '../../features/search/location'

export function locateRichText(editor: Crepe, query: string) {
  return editor.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    let match: { from: number; to: number } | undefined
    view.state.doc.descendants((node, position) => {
      if (match) return false
      if (!node.isTextblock) return true
      let text = ''
      const spans: { offset: number; position: number; length: number }[] = []
      node.descendants((child, offset) => {
        if (child.isText) {
          spans.push({ offset: text.length, position: position + 1 + offset, length: child.text!.length })
          text += child.text
        } else if (child.isLeaf) text += '\n'
      })
      const range = literalRange(text, query)
      if (range) {
        const start = spans.find((span) => range.from >= span.offset && range.from < span.offset + span.length)
        const end = spans.find((span) => range.to > span.offset && range.to <= span.offset + span.length)
        if (start && end) match = { from: start.position + range.from - start.offset, to: end.position + range.to - end.offset }
      }
      return false
    })
    if (!match) return false
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to)).scrollIntoView())
    view.focus()
    return true
  })
}
