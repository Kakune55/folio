import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

export const codeHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operator, tags.typeName, tags.className], color: 'var(--syntax-keyword)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--accent)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.comment, tags.meta], color: 'var(--muted-foreground)' },
  { tag: [tags.heading, tags.link], color: 'var(--accent)' },
  { tag: tags.strong, fontWeight: 'bold' }, { tag: tags.emphasis, fontStyle: 'italic' },
])

// 独立源码与 Markdown 内代码共用语义色，不替换正文或重建视图。
export const codeTheme = [
  EditorView.theme({
    '&': { color: 'var(--foreground)', backgroundColor: 'var(--code)' },
    '.cm-gutters': { color: 'var(--muted-foreground)', backgroundColor: 'var(--code)', border: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-hover)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  }),
  syntaxHighlighting(codeHighlightStyle),
]
