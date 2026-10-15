import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

// 源码与富文本代码块共用语义色，切换主题无需重建文档。
export const codeTheme = [
  EditorView.theme({
    '&': { color: 'var(--foreground)', backgroundColor: 'var(--code)' },
    '.cm-gutters': { color: 'var(--muted-foreground)', backgroundColor: 'var(--code)', border: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface-hover)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.operator], color: 'var(--syntax-keyword)' },
    { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
    { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
    { tag: [tags.comment, tags.meta], color: 'var(--muted-foreground)' },
    { tag: [tags.heading, tags.link], color: 'var(--accent)' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
  ])),
]
