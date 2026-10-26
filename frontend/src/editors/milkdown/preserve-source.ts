import type { Node as PMNode } from '@milkdown/kit/prose/model'

export type MarkdownAst = {
  type: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownAst[]
  meta?: unknown
}

type Tools = {
  parse: (source: string) => PMNode | null | undefined
  serialize: (doc: PMNode) => string
  ast: (source: string) => MarkdownAst
}
type Snapshot = { source: string; semantic: string; keys: string[]; raw: string[]; gaps: string[] }
type Prepared = { source: string; commit: () => void } | { error: string }
const maxChars = 1_000_000
const maxSnapshotBytes = 8 * 1024 * 1024
const maxHistoryBytes = 16 * 1024 * 1024

/** 规范化对象键顺序，仅删除已知不持久化的派生显示属性。 */
export function semanticDoc(node: PMNode): string {
  const json = node.toJSON()
  const stripDerivedAttrs = (value: typeof json) => {
    if (value.type === 'heading' && value.attrs)
      value.attrs = Object.fromEntries(Object.entries(value.attrs).filter(([key]) => key !== 'id'))
    // serializer 不持久化 label/listType；父列表节点名与 ordered_list.order 完整保留列表语义。
    // splitListItem 会暂时复制旧 label，后续 append 才更新编号，不能因此拒绝合法 split。
    if (value.type === 'list_item' && value.attrs)
      value.attrs = Object.fromEntries(Object.entries(value.attrs).filter(([key]) => key !== 'label' && key !== 'listType'))
    value.content?.forEach(stripDerivedAttrs)
  }
  stripDerivedAttrs(json)
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    const object = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])]))
  }
  return JSON.stringify(canonical(json))
}

function budget(source: string) {
  if (source.length > maxChars || (source.match(/\r\n|\r|\n/g)?.length ?? 0) >= 20_000)
    throw new Error('保源输入超过 100 万字符或 2 万行限制，请使用源码编辑。')
}

function isDefaultEmptyParagraph(node: PMNode | null) {
  return node?.type.name === 'paragraph' && node.childCount === 0 && node.eq(node.type.create())
}

// 仅投影一个额外默认尾段；连续空段、属性、marks 和 hardbreak 都不属于占位。
function withoutVirtualTail(doc: PMNode): PMNode | undefined {
  if (doc.childCount < 2 || !isDefaultEmptyParagraph(doc.lastChild)
    || isDefaultEmptyParagraph(doc.child(doc.childCount - 2))) return
  return doc.copy(doc.content.cut(0, doc.content.size - doc.lastChild!.nodeSize))
}

function trailingNewlines(source: string) {
  return source.match(/[\t \r\n]*$/)?.[0].match(/\r\n|\r|\n/g)?.length ?? 0
}

function index(source: string, doc: PMNode, tools: Tools): Snapshot {
  budget(source)
  const opening = /^\uFEFF?(---|\+\+\+)[ \t]*(?:\r\n|\r|\n)/.exec(source)
  if (opening) {
    const rest = source.slice(opening[0].length)
    const closing = opening[1] === '---'
      ? /^(?:---|\.\.\.)[ \t]*(?:\r?$|\r)/m
      : /^\+\+\+[ \t]*(?:\r?$|\r)/m
    const metadata = opening[1] === '---'
      ? /^[ \t]*[^\s:][^\r\n]*:[ \t]*(?:[^\r\n]*)(?:\r\n|\r|\n|$)/
      : /^[ \t]*(?:[^\s=][^\r\n]*=|\[[^\r\n]+\])/
    if (closing.test(rest) || metadata.test(rest))
      throw new Error('frontmatter 无法完整表达为富文本，请保留源码。')
  }
  // remark 在预处理时移除 BOM，其 offset 相对于去 BOM 后的 UTF-16 正文。
  const bom = source.startsWith('\uFEFF') ? 1 : 0
  const ast = tools.ast(source.slice(bom))
  const pending = [ast]
  let visited = 0
  while (pending.length) {
    const node = pending.pop()!
    if (++visited > 100_000) throw new Error('Markdown AST 超过保源节点预算。')
    if (['definition', 'linkReference', 'imageReference', 'yaml', 'toml'].includes(node.type)
      || (node.type === 'code' && node.meta != null && node.meta !== ''))
      throw new Error('引用定义、frontmatter 或代码 meta 无法安全保源，请使用源码。')
    for (const child of node.children ?? []) pending.push(child)
  }
  const parsed = tools.parse(source)
  if (!parsed) throw new Error('原文解析失败。')
  const parsedSemantic = semanticDoc(parsed)
  if (parsedSemantic !== semanticDoc(doc)) {
    const projected = withoutVirtualTail(doc)
    if (!projected || semanticDoc(projected) !== parsedSemantic)
      throw new Error('原文解析与编辑文档语义不一致。')
    doc = projected
  }
  const semantic = parsedSemantic
  const children = ast.children ?? []
  const raw: string[] = [], gaps: string[] = [], keys: string[] = []
  let end = 0
  // PM 常用单个空段落表示空文件；不凭 AST/PM 数量猜测其他映射。
  if (!children.length) {
    if (!/^[\s\uFEFF]*$/.test(source)) throw new Error('空 AST 含有未映射原文。')
    return { source, semantic, raw, gaps: [source], keys }
  }
  if (children.length !== doc.childCount) throw new Error('顶层 Markdown 块无法逐块映射。')
  children.forEach((child, i) => {
    const rawStart = child.position?.start.offset, rawStop = child.position?.end.offset
    const start = rawStart === undefined ? undefined : rawStart + bom
    const stop = rawStop === undefined ? undefined : rawStop + bom
    if (!Number.isInteger(start) || !Number.isInteger(stop) || start! < end || stop! <= start! || stop! > source.length)
      throw new Error('Markdown AST 源码区间无效。')
    const gap = source.slice(end, start)
    if (!/^[\t \r\n\uFEFF]*$/.test(gap)) throw new Error('块间存在未映射正文。')
    const text = source.slice(start, stop)
    const single = tools.parse(text)
    const key = semanticDoc(doc.child(i))
    if (!single || single.childCount !== 1 || semanticDoc(single.child(0)) !== key)
      throw new Error('独立块解析与原文对应节点不一致。')
    gaps.push(gap); raw.push(text); keys.push(key); end = stop!
  })
  const tail = source.slice(end)
  if (!/^[\t \r\n]*$/.test(tail)) throw new Error('末尾存在未映射正文。')
  gaps.push(tail)
  return { source, semantic, raw, gaps, keys }
}

export class SourcePreserver {
  private history: Snapshot[]
  private bytes: number
  private revision = 0
  private current: Snapshot
  private tools: Tools
  constructor(current: Snapshot, tools: Tools) {
    this.current = current
    this.tools = tools
    this.history = [current]
    this.bytes = this.size(current)
    if (this.bytes > maxSnapshotBytes) throw new Error('初始保源快照超过单快照 8 MiB 预算。')
  }
  private size(snapshot: Snapshot) {
    // 同时计入原文、语义键和切片，按 UTF-16 上界记账。
    return 2 * (snapshot.source.length + snapshot.semantic.length
      + snapshot.keys.join('').length + snapshot.raw.join('').length + snapshot.gaps.join('').length)
  }
  prepare(doc: PMNode): Prepared {
    try {
      let semantic = semanticDoc(doc)
      if (semantic.length > 4 * maxChars) throw new Error('目标文档超过保源语义预算。')
      const base = this.current, revision = this.revision
      const finish = (snapshot: Snapshot, fresh: boolean): Prepared => ({
        source: snapshot.source,
        commit: () => {
          if (this.revision !== revision) throw new Error('保源预检已过期，请重新预检。')
          if (fresh) { this.history.push(snapshot); this.bytes += this.size(snapshot) }
          else if (snapshot !== this.history[0]) {
            this.history.splice(this.history.indexOf(snapshot), 1)
            this.history.push(snapshot)
          }
          this.current = snapshot; this.revision++
          // 初始记录固定在首位，当前记录在末位；只在提交时淘汰最旧的其他记录。
          while (this.history.length > 50 || this.bytes > maxHistoryBytes) {
            const [removed] = this.history.splice(1, 1)
            this.bytes -= this.size(removed)
          }
        },
      })
      let known = this.history.find(snapshot => snapshot.semantic === semantic)
      if (known) return finish(known, false)
      const projected = withoutVirtualTail(doc)
      // 已映射原文的显式空段必须保留，不能因它恰好在末尾而吞掉。
      if (projected && base.keys.at(-1) !== semanticDoc(doc.lastChild!)) {
        doc = projected
        semantic = semanticDoc(doc)
        known = this.history.find(snapshot => snapshot.semantic === semantic)
        if (known) return finish(known, false)
      }
      const keys: string[] = []
      doc.forEach(node => keys.push(semanticDoc(node)))
      const empty = this.tools.parse('')
      if (empty && semanticDoc(empty) === semantic) keys.length = 0
      if (base.source.length + semantic.length > 4 * maxChars) throw new Error('保源比较超过输入预算。')
      const identities = new Map<string, string>()
      const ambiguous = new Set<string>()
      base.keys.forEach((key, i) => {
        if (identities.has(key) && identities.get(key) !== base.raw[i])
          ambiguous.add(key)
        identities.set(key, base.raw[i])
      })
      let prefix = 0, suffix = 0
      while (prefix < base.keys.length && prefix < keys.length && base.keys[prefix] === keys[prefix]) prefix++
      while (suffix < base.keys.length - prefix && suffix < keys.length - prefix
        && base.keys[base.keys.length - 1 - suffix] === keys[keys.length - 1 - suffix]) suffix++
      if (base.keys.slice(prefix, base.keys.length - suffix).some(key => ambiguous.has(key))
        || keys.slice(prefix, keys.length - suffix).some(key => ambiguous.has(key)))
        throw new Error('重复语义块具有不同源码，无法确定编辑身份。')
      const n = base.keys.length - prefix - suffix, m = keys.length - prefix - suffix
      if ((n + 1) * (m + 1) > 250_000) throw new Error('顶层块匹配超过 LCS 预算，请使用源码。')
      const rows = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
        rows[i][j] = base.keys[prefix + i] === keys[prefix + j]
          ? 1 + rows[i + 1][j + 1] : Math.max(rows[i + 1][j], rows[i][j + 1])
      const matches: [number, number][] = Array.from({ length: prefix }, (_, i) => [i, i])
      let i = 0, j = 0
      while (i < n && j < m) {
        if (base.keys[prefix + i] === keys[prefix + j]) { matches.push([prefix + i++, prefix + j++]); continue }
        if (rows[i + 1][j] >= rows[i][j + 1]) i++; else j++
      }
      for (let k = suffix; k > 0; k--) matches.push([base.keys.length - k, keys.length - k])
      matches.push([base.keys.length, keys.length])
      const newline = base.source.match(/\r\n|\r|\n/)?.[0] ?? '\n'
      let source = base.gaps[0], old = 0, next = 0
      let generatedChars = 0
      for (const [a, b] of matches) {
        const generated: string[] = []
        for (; next < b; next++) {
          if (isDefaultEmptyParagraph(doc.child(next)))
            throw new Error('未映射的额外空段落无法安全写入源码，请保留当前正文。')
          const reused = identities.get(keys[next])
          if (reused !== undefined) {
            generatedChars += reused.length
            if (generatedChars + base.source.length > maxChars) throw new Error('生成块合计超过保源输入预算。')
            generated.push(reused)
            continue
          }
          const wrapper = doc.type.create(doc.attrs, [doc.child(next)], doc.marks)
          const serialized = this.tools.serialize(wrapper)
          budget(serialized)
          generatedChars += serialized.length
          if (generatedChars + base.source.length > maxChars) throw new Error('生成块合计超过保源输入预算。')
          const blocks = this.tools.ast(serialized).children ?? []
          const stop = blocks.at(-1)?.position?.end.offset
          if (blocks.length !== 1 || stop === undefined || !/^[\t \r\n]*$/.test(serialized.slice(stop)))
            throw new Error('变化块不能独立序列化，空段落或多块输出无法保源。')
          generated.push(serialized.slice(0, stop).replace(/\r\n|\r|\n/g, newline))
        }
        if (generated.length && old === a && old > 0)
          source += newline.repeat(Math.max(0, 2 - trailingNewlines(source)))
        source += generated.join(newline + newline)
        // 删除/合并后仍保留原有各个 gap；只为新增邻接补充分隔。
        for (; old < a; old++) source += base.gaps[old + 1]
        if (a < base.keys.length) {
          if (generated.length && a === old)
            source += newline.repeat(Math.max(0, 2 - trailingNewlines(source)))
          source += base.raw[a] + base.gaps[a + 1]
          old = a + 1; next = b + 1
        }
      }
      budget(source)
      if (base.source.length + source.length > maxChars) throw new Error('前后正文合计超过 100 万字符保源比较预算。')
      const candidate = index(source, doc, this.tools)
      if (this.size(candidate) > maxSnapshotBytes)
        throw new Error('候选保源快照超过单快照 8 MiB 预算；当前正文未变。')
      return finish(candidate, true)
    } catch (error) {
      return { error: error instanceof Error ? error.message : '保源预检失败，当前正文未变。' }
    }
  }
}

export function createSourcePreserver(source: string, doc: PMNode, tools: Tools): { preserver?: SourcePreserver; reason?: string } {
  try {
    const snapshot = index(source, doc, tools)
    const preserver = new SourcePreserver(snapshot, tools)
    return { preserver }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : '无法建立保源索引。' }
  }
}
