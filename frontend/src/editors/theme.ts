import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { highlightTree, tags } from '@lezer/highlight'

const rainbowColors = ['brace', 'bracket', 'paren', 'number', 'property', 'keyword']

export function rainbowBracketDecorations(state: EditorState) {
  const tree = syntaxTree(state), ranges: Range<Decoration>[] = []
  const blocks: { from: number; to: number }[] = []
  // 不主动补解析长文档；仅给预算内已解析的代码着色，各围栏单独计数。
  const end = Math.min(state.doc.length, 200000)
  if (tree.topNode.name === 'Document') tree.iterate({ to: end, enter(node) {
    if (node.name === 'FencedCode') { blocks.push({ from: node.from, to: node.to }); return false }
  } })
  else blocks.push({ from: 0, to: end })
  let block = 0
  const stack: { bracket: string; depth: number }[] = []
  highlightTree(tree, { style: tokenTags => tokenTags.some(tag => tag.set.includes(tags.bracket)) ? 'bracket' : null }, (from, to) => {
    while (block < blocks.length && from >= blocks[block].to) { block++; stack.length = 0 }
    if (!blocks[block] || from < blocks[block].from) return
    for (let position = from; position < to; position++) {
      const bracket = state.sliceDoc(position, position + 1)
      let depth: number
      if ('([{'.includes(bracket)) {
        depth = stack.length; stack.push({ bracket, depth })
      } else if (')]}'.includes(bracket)) {
        const opening = stack.at(-1)
        if (!opening || '([{'.indexOf(opening.bracket) !== ')]}'.indexOf(bracket)) continue
        depth = stack.pop()!.depth
      } else continue
      ranges.push(Decoration.mark({ class: `folio-rainbow-${depth % rainbowColors.length}` }).range(position, position + 1))
    }
  }, 0, end)
  return Decoration.set(ranges, true)
}

const rainbowBrackets = StateField.define({
  create: rainbowBracketDecorations,
  update: (value, transaction) => transaction.docChanged || syntaxTree(transaction.state) !== syntaxTree(transaction.startState) ? rainbowBracketDecorations(transaction.state) : value,
  provide: field => EditorView.decorations.from(field),
})

export const codeHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.typeName, tags.className, tags.bool, tags.null], color: 'var(--syntax-keyword)' },
  { tag: tags.operator, color: 'var(--syntax-operator)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--syntax-property)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syntax-function)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: tags.number, color: 'var(--syntax-number)' },
  { tag: tags.punctuation, color: 'var(--syntax-operator)' },
  { tag: tags.brace, color: 'var(--syntax-brace)' },
  { tag: tags.squareBracket, color: 'var(--syntax-bracket)' },
  { tag: tags.paren, color: 'var(--syntax-paren)' },
  { tag: [tags.comment, tags.meta], color: 'var(--muted-foreground)' },
  { tag: [tags.heading, tags.link], color: 'var(--accent)' },
  { tag: tags.strong, fontWeight: 'bold' }, { tag: tags.emphasis, fontStyle: 'italic' },
])

// 独立源码与 Markdown 内代码共用语义色，不替换正文或重建视图。
export const codeTheme = [
  EditorView.theme({
    ...Object.fromEntries(rainbowColors.map((color, index) => [`.folio-rainbow-${index}, .folio-rainbow-${index} span`, { color: `var(--syntax-${color}) !important` }])),
    '&': { color: 'var(--foreground)', backgroundColor: 'var(--code)' },
    '.cm-gutters': { color: 'var(--muted-foreground)', backgroundColor: 'var(--code)', border: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-hover)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--selection)', textDecoration: 'underline', textUnderlineOffset: '3px' },
    '.cm-nonmatchingBracket': { color: 'var(--destructive)', textDecoration: 'underline wavy' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  }),
  syntaxHighlighting(codeHighlightStyle),
  rainbowBrackets,
]
