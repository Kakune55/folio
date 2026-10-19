import { markdownLanguage } from '@codemirror/lang-markdown'

// 仅在用户明确跳转时解析，代码块和行内代码中的伪链接不会触发导航。
export function markdownLinkAt(source: string, position: number) {
  const tree = markdownLanguage.parser.parse(source)
  let node = tree.resolveInner(position, -1)
  while (node.parent && !['Link', 'Image', 'Autolink'].includes(node.name)) node = node.parent
  if (!['Link', 'Image', 'Autolink'].includes(node.name)) return undefined
  const decode = (from: number, to: number) => source.slice(from, to).replace(/^<|>$/g, '').replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
  const url = node.getChild('URL')
  if (url) return decode(url.from, url.to)
  const normalize = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase()
  const label = node.getChild('LinkLabel')
  const text = source.slice(node.from, node.to)
  const firstLabel = /^!?\[([^\]]*)\]/.exec(text)?.[1] ?? ''
  const wanted = normalize(label ? source.slice(label.from + 1, label.to - 1) || firstLabel : firstLabel)
  let result: string | undefined
  tree.iterate({ enter(candidate) {
    if (candidate.name !== 'LinkReference' || result !== undefined) return
    const key = candidate.node.getChild('LinkLabel'), value = candidate.node.getChild('URL')
    if (key && value && normalize(source.slice(key.from + 1, key.to - 1)) === wanted) result = decode(value.from, value.to)
  } })
  return result
}
