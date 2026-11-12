import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { GFM } from '@lezer/markdown'
import { mathMarkdown } from './math-syntax'
import { githubAlert } from './github-alerts'

const characterBudget = 100000
const nodeBudget = 4000
const language = markdown({ base: commonmarkLanguage, extensions: [GFM, mathMarkdown] })
const normalizeLabel = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase()

export function decodeMarkdownTarget(raw: string): string {
  const text = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
  const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }
  // 单次替换，既不解析 HTML，也不再次解码转义或实体产生的文本。
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])|&(#(?:[xX][\da-fA-F]{1,6}|[0-9]{1,7})|amp|quot|apos|lt|gt);/g, (_match, escaped: string | undefined, entity: string) => {
    if (escaped !== undefined) return escaped
    if (!entity.startsWith('#')) return entities[entity]
    const code = /^#x/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code)
  })
}

export function markdownReferences(state: EditorState): Map<string, string> {
  const references = new Map<string, string>()
  const cursor = syntaxTree(state).cursor()
  let visited = 0
  do {
    if (++visited > nodeBudget || cursor.from >= characterBudget) break
    if (cursor.name !== 'LinkReference' || cursor.to > characterBudget) continue
    const label = cursor.node.getChild('LinkLabel'), url = cursor.node.getChild('URL')
    if (!label || !url) continue
    const key = normalizeLabel(state.sliceDoc(label.from + 1, label.to - 1))
    if (!references.has(key)) references.set(key, decodeMarkdownTarget(state.sliceDoc(url.from, url.to)))
  } while (cursor.next(!['FencedCode', 'CodeBlock', 'InlineCode'].includes(cursor.name)))
  return references
}

export function markdownLinkTarget(state: EditorState, node: SyntaxNode, references?: ReadonlyMap<string, string>): string | undefined {
  let link: SyntaxNode | undefined
  let bareURL: SyntaxNode | undefined
  let visited = 0
  for (let current: SyntaxNode | null = node; current; current = current.parent) {
    if (++visited > nodeBudget) return undefined
    if (['InlineCode', 'FencedCode', 'CodeBlock', 'LinkReference', 'InlineMath', 'MathBlock'].includes(current.name)) return undefined
    if (current.name === 'Blockquote') {
      const alert = githubAlert(state, current)
      if (alert && node.from >= alert.from && node.to <= alert.to) return undefined
    }
    if (!link && ['Link', 'Image', 'Autolink'].includes(current.name)) link = current
    if (current.name === 'URL') bareURL = current
  }
  const target = link ?? bareURL
  if (!target || target.from < 0 || target.to > Math.min(state.doc.length, characterBudget)) return undefined
  const marks = link?.getChildren('LinkMark') ?? []
  // GFM 也会在链接标签内产生 URL；只有括号后的 URL 才是内联目标。
  const url = !link ? bareURL : link.name === 'Autolink' ? link.getChild('URL') :
    marks.length > 2 ? link.getChildren('URL').find(candidate => candidate.from >= marks[2].to) : undefined
  if (url) {
    const raw = state.sliceDoc(url.from, url.to)
    if (!link && !/^(?:https?:\/\/|www\.)/i.test(raw)) return undefined
    const decoded = decodeMarkdownTarget(raw)
    if (!link || link.name === 'Autolink') {
      if (/^www\./i.test(decoded)) return `https://${decoded}`
      if (!decoded.includes(':') && decoded.includes('@')) return `mailto:${decoded}`
    }
    return decoded
  }
  if (!link || link.name === 'Autolink') return undefined
  // 空目标 () 仍是内联链接；不能回退到同名引用定义。
  if (marks.length > 2) return ''
  if (marks.length !== 2) return undefined
  const label = link.getChild('LinkLabel')
  const explicit = label && state.sliceDoc(label.from + 1, label.to - 1)
  const key = normalizeLabel(explicit || state.sliceDoc(marks[0].to, marks[1].from))
  return (references ?? markdownReferences(state)).get(key)
}

// 仅在用户明确跳转时建立状态；预览直接复用已有语法树，不强制继续解析。
export function markdownLinkAt(source: string, position: number): string | undefined {
  if (!Number.isInteger(position) || position < 0 || position > source.length || source.length > characterBudget) return undefined
  const state = EditorState.create({ doc: source, extensions: [EditorState.lineSeparator.of('\n'), language] })
  const node = syntaxTree(state).resolveInner(position, position === 0 ? 1 : -1)
  return markdownLinkTarget(state, node)
}
