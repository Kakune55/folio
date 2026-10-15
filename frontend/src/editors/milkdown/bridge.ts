export type CrepeBridge = {
  upload: (file: File) => Promise<string>
  imageURL: (url: string) => string
  openLink: (url: string) => void
  beginUpload: () => void
  endUpload: () => void
  attached?: () => boolean
  detachedImage: (url: string, alt: string) => void
}
// 只解析工作区中的标准路径；上溢、非法编码和 URL 协议均明确拒绝。
export function resolveFileLink(documentPath: string, href: string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) throw new Error('只支持工作区相对文件路径')
  const pathname = decodeURIComponent(href.split(/[?#]/, 1)[0])
  if (!pathname || [...pathname].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\')) throw new Error('文件链接路径无效')
  const parts = pathname.startsWith('/') ? [] : documentPath.split('/').slice(0, -1)
  for (const part of pathname.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) throw new Error('文件链接超出工作区'); parts.pop() }
    else parts.push(part)
  }
  if (!parts.length) throw new Error('文件链接未指向文件')
  return parts.join('/')
}
export function relativeFileLink(documentPath: string, target: string) {
  const from = documentPath.split('/').slice(0, -1), to = target.split('/')
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift() }
  const encoded = to.map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
  return `${from.length ? '../'.repeat(from.length) : './'}${encoded}`
}
export function imageMarkdown(url: string, alt: string) { return `![${alt.replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]/g, ' ')}](${url})` }
