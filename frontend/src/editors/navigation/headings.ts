import { markdownLanguage } from '@codemirror/lang-markdown'

export function sourceHeadings(source: string) {
  const headings: { from: number; level: number; text: string }[] = []
  markdownLanguage.parser.parse(source).iterate({ enter(node) {
    const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)
    if (!match) return
    const text = source.slice(node.from, node.to).replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').replace(/\n[=-]+\s*$/, '').trim()
    headings.push({ from: node.from, level: Number(match[1]), text })
  } })
  return headings
}
