import { describe, expect, it, vi } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { splitListItem } from '@milkdown/kit/prose/schema-list'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import type { Root, RootContent } from 'mdast'
import { createSourcePreserver, semanticDoc, type SourcePreserver } from './preserve-source'

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify)
const schema = new Schema({ nodes: {
  doc: { content: 'block*' },
  paragraph: { group: 'block', attrs: { tree: { default: null } } },
  heading: { group: 'block', attrs: { tree: { default: null }, id: { default: '' } } },
  text: {},
} })
// 使用真实 remark 位置与完整语义树，PM 容器不依赖浏览器或 Crepe DOM。
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'position').map(([key, item]) => [key, clean(item)]))
}
const ast = (source: string) => processor.parse(source)
const parse = (source: string) => schema.node('doc', null, ast(source).children.map(tree =>
  schema.node(tree.type === 'heading' ? 'heading' : 'paragraph', { tree: clean(tree) })))
const serialize = vi.fn((doc: PMNode) => {
  const children: RootContent[] = []
  doc.forEach(node => children.push(node.attrs.tree as RootContent))
  return processor.stringify({ type: 'root', children } as Root)
})
const tools = { parse, ast, serialize }
function setup(source: string) {
  const result = createSourcePreserver(source, parse(source), tools)
  expect(result.reason).toBeUndefined()
  return result.preserver!
}
function prepare(preserver: SourcePreserver, source: string) {
  const result = preserver.prepare(parse(source))
  if ('error' in result) throw new Error(result.error)
  return result
}

// 模拟 Milkdown 的实际段落/代码语义及 preserve-empty-line 的显式 <br />。
const trailingSchema = new Schema({ nodes: {
  doc: { content: 'block*', marks: '_' },
  paragraph: { group: 'block', content: 'inline*', attrs: { align: { default: null } } },
  code_block: { group: 'block', content: 'text*', attrs: { language: { default: '' } } },
  list: { group: 'block', attrs: { tree: {} } },
  table: { group: 'block', attrs: { tree: {} } },
  hardbreak: { group: 'inline', inline: true },
  text: { group: 'inline' },
}, marks: { strong: {} } })
const trailingParse = (source: string) => trailingSchema.node('doc', null, ast(source).children.map(tree => {
  if (tree.type === 'code') return trailingSchema.node('code_block', { language: tree.lang ?? '' }, tree.value ? trailingSchema.text(tree.value) : undefined)
  if (tree.type === 'list' || tree.type === 'table') return trailingSchema.node(tree.type, { tree: clean(tree) })
  if (tree.type === 'html' && /^<br\s*\/?>$/.test(tree.value)) return trailingSchema.node('paragraph')
  if (tree.type !== 'paragraph') throw new Error('测试解析器不支持此节点')
  return trailingSchema.node('paragraph', null, tree.children.map(child => {
    if (child.type === 'break') return trailingSchema.node('hardbreak')
    if (child.type !== 'text') throw new Error('测试解析器不支持此行内节点')
    return trailingSchema.text(child.value)
  }))
}))
const trailingSerialize = vi.fn((doc: PMNode) => {
  const blocks: string[] = []
  doc.forEach(node => {
    if (node.type.name === 'paragraph') blocks.push(node.childCount ? node.textContent : '<br />')
    else if (node.type.name === 'code_block') blocks.push(`\`\`\`${node.attrs.language}\n${node.textContent}\n\`\`\``)
    else blocks.push(processor.stringify({ type: 'root', children: [node.attrs.tree] } as Root).replace(/\n$/, ''))
  })
  return blocks.join('\n\n') + '\n'
})
const trailingTools = { parse: trailingParse, serialize: trailingSerialize, ast }
function appendEmpty(doc: PMNode, count = 1) {
  const nodes: PMNode[] = []
  doc.forEach(node => nodes.push(node))
  for (let i = 0; i < count; i++) nodes.push(trailingSchema.node('paragraph'))
  return trailingSchema.node('doc', null, nodes)
}

describe('保源纯逻辑适配器', () => {
  it('list_item 仅忽略派生 label/listType，持久化属性及父列表语义仍严格比较', () => {
    const listSchema = new Schema({ nodes: {
      doc: { content: 'block+' },
      ordered_list: { group: 'block', content: 'list_item+', attrs: { order: { default: 1 }, spread: { default: false } } },
      bullet_list: { group: 'block', content: 'list_item+', attrs: { order: { default: 1 }, spread: { default: false } } },
      list_item: { content: 'paragraph+', attrs: {
        label: { default: '1.' }, listType: { default: 'ordered' }, checked: { default: null },
        spread: { default: false }, other: { default: null },
      } },
      paragraph: { content: 'text*' }, text: {},
    } })
    const make = (itemAttrs = {}, listAttrs = {}, type = 'ordered_list') => listSchema.node('doc', null, [
      listSchema.node(type, listAttrs, [listSchema.node('list_item', itemAttrs, [listSchema.node('paragraph')])]),
    ])
    const base = semanticDoc(make())
    expect(semanticDoc(make({ label: '2.' }))).toBe(base)
    expect(semanticDoc(make({ listType: 'bullet' }))).toBe(base)
    for (const attrs of [{ checked: true }, { checked: false }, { spread: true }, { other: 'keep' }])
      expect(semanticDoc(make(attrs))).not.toBe(base)
    expect(semanticDoc(make({}, { order: 2 }))).not.toBe(base)
    expect(semanticDoc(make({}, { spread: true }))).not.toBe(base)
    expect(semanticDoc(make({}, {}, 'bullet_list'))).not.toBe(base)
    const paragraphAttrs = new Schema({ nodes: {
      doc: { content: 'paragraph' }, paragraph: { attrs: { label: { default: 'a' }, listType: { default: 'ordered' } } }, text: {},
    } })
    const paragraphDoc = (attrs = {}) => paragraphAttrs.node('doc', null, [paragraphAttrs.node('paragraph', attrs)])
    expect(semanticDoc(paragraphDoc({ label: 'b' }))).not.toBe(semanticDoc(paragraphDoc()))
    expect(semanticDoc(paragraphDoc({ listType: 'bullet' }))).not.toBe(semanticDoc(paragraphDoc()))
  })

  it.each([false, true])('实际 splitListItem 回车候选通过保源预检，ordered=%s', ordered => {
    const listSchema = new Schema({ nodes: {
      doc: { content: 'block+' },
      ordered_list: { group: 'block', content: 'list_item+', attrs: { order: { default: 1 } } },
      bullet_list: { group: 'block', content: 'list_item+' },
      list_item: { content: 'paragraph+', attrs: {
        label: { default: '•' }, listType: { default: 'bullet' }, spread: { default: false }, checked: { default: null },
      } },
      paragraph: { group: 'block', content: 'text*' }, text: {},
    } })
    const listParse = (source: string) => {
      const tree = ast(source).children[0]
      if (!tree) return listSchema.node('doc', null, [listSchema.node('paragraph')])
      if (tree.type !== 'list') throw new Error('测试解析器仅支持列表')
      return listSchema.node('doc', null, [listSchema.node(tree.ordered ? 'ordered_list' : 'bullet_list', tree.ordered ? { order: tree.start } : null,
        tree.children.map((item, i) => listSchema.node('list_item', {
          label: tree.ordered ? `${(tree.start ?? 1) + i}.` : '•', listType: tree.ordered ? 'ordered' : 'bullet',
          spread: item.spread, checked: item.checked ?? null,
        }, [listSchema.node('paragraph', null, item.children[0]?.type === 'paragraph'
          ? item.children[0].children.filter(child => child.type === 'text').map(child => listSchema.text(child.value)) : undefined)])))])
    }
    const listSerialize = vi.fn((doc: PMNode) => {
      const list = doc.firstChild!, lines: string[] = []
      list.forEach((item, _offset, i) => lines.push(`${list.type.name === 'ordered_list' ? `${list.attrs.order + i}.` : '-'} ${item.textContent}`))
      return lines.join('\n') + '\n'
    })
    const original = `${ordered ? '1.' : '-'} item\n`
    const doc = listParse(original)
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 7) })
    expect(splitListItem(listSchema.nodes.list_item)(state, tr => { state = state.apply(tr) })).toBe(true)
    expect(state.doc.firstChild!.childCount).toBe(2)
    if (ordered) expect(state.doc.firstChild!.child(1).attrs.label).toBe('1.')
    const preserver = createSourcePreserver(original, doc, { parse: listParse, serialize: listSerialize, ast }).preserver!
    const candidate = preserver.prepare(state.doc)
    if ('error' in candidate) throw new Error(candidate.error)
    expect(candidate.source).toBe(`${ordered ? '1.' : '-'} item\n${ordered ? '2.' : '-'} \n`)
    expect(semanticDoc(listParse(candidate.source))).toBe(semanticDoc(state.doc))
    expect(listSerialize).toHaveBeenCalledTimes(1)
    candidate.commit()
    expect(preserver.prepare(doc)).toMatchObject({ source: original })
  })

  it.each(['~~~~js\nold\n~~~~', '- item', '| a |\n| - |\n| b |'])('非段落尾块的单个 trailing 占位不写回源：%s', block => {
    const source = `intro\n\n${block}`
    const doc = appendEmpty(trailingParse(source))
    expect(doc.childCount).toBe(3)
    const initial = createSourcePreserver(source, doc, trailingTools)
    expect(initial.reason).toBeUndefined()
    const preserver = initial.preserver!
    trailingSerialize.mockClear()
    const placeholder = preserver.prepare(doc)
    expect(placeholder).toMatchObject({ source })
    expect(trailingSerialize).not.toHaveBeenCalled()
    if ('error' in placeholder) throw new Error(placeholder.error)
    placeholder.commit()
    const next = trailingParse(`${source}\n\nnew text`)
    const typed = preserver.prepare(next)
    if ('error' in typed) throw new Error(typed.error)
    expect(typed.source.startsWith(source)).toBe(true)
    expect(semanticDoc(trailingParse(typed.source))).toBe(semanticDoc(next))
    expect(trailingSerialize).toHaveBeenCalledTimes(1)
    typed.commit()
    expect(createSourcePreserver(typed.source, next, trailingTools).reason).toBeUndefined()
    expect(createSourcePreserver(source, appendEmpty(trailingParse(source)), trailingTools).reason).toBeUndefined()
    // semanticDoc 本身始终严格保留空段，只有适配器进行受控投影。
    expect(semanticDoc(doc)).not.toBe(semanticDoc(trailingParse(source)))
  })

  it('段落末 Enter 一次只产生虚拟尾段，键入后成为真实新块', () => {
    const source = 'intro'
    const preserver = createSourcePreserver(source, trailingParse(source), trailingTools).preserver!
    trailingSerialize.mockClear()
    const enter = preserver.prepare(appendEmpty(trailingParse(source)))
    expect(enter).toMatchObject({ source })
    if ('error' in enter) throw new Error(enter.error)
    expect(trailingSerialize).not.toHaveBeenCalled()
    enter.commit()
    const typed = preserver.prepare(trailingParse('intro\n\nnext'))
    expect(typed).toMatchObject({ source: 'intro\n\nnext' })
  })

  it.each(['', '\n', '\r\n', '\n \n', '\r\n \r\n'])('连续 Enter 虚拟尾段后键入新段，只补缺少的分隔：%s', gap => {
    const original = `编辑目标。${gap}`
    const preserver = createSourcePreserver(original, trailingParse(original), trailingTools).preserver!
    const apply = (doc: PMNode) => {
      const result = preserver.prepare(doc)
      if ('error' in result) throw new Error(result.error)
      result.commit()
      return result.source
    }
    expect(apply(trailingParse('Ａ'))).toBe(`Ａ${gap}`)
    expect(apply(appendEmpty(trailingParse('Ａ')))).toBe(`Ａ${gap}`)
    const newline = gap.includes('\r\n') ? '\r\n' : '\n'
    const count = gap.match(/\r\n|\r|\n/g)?.length ?? 0
    const expected = `Ａ${gap}${newline.repeat(Math.max(0, 2 - count))}Ｂ`
    expect(apply(trailingParse('Ａ\n\nＢ'))).toBe(expected)
    expect(apply(appendEmpty(trailingParse('Ａ\n\nＢ')))).toBe(expected)
    expect(apply(trailingParse('Ａ\n\nＢ\n\nＣ'))).toBe(`${expected}${newline}${newline}Ｃ`)
    expect(apply(trailingParse('编辑目标。'))).toBe(original)
  })

  it('替换既有块不为合法单 LF 边界追加空行', () => {
    const source = 'intro\n```js\nold\n```'
    const preserver = createSourcePreserver(source, appendEmpty(trailingParse(source)), trailingTools).preserver!
    const result = preserver.prepare(appendEmpty(trailingParse('intro\n```js\nnew\n```')))
    expect(result).toMatchObject({ source: 'intro\n```js\nnew\n```' })
  })

  it('代码编辑保留 trailing 占位但不序列化它，重新打开无拒绝原因', () => {
    const source = 'intro\n\n~~~~js\nold\n~~~~'
    const preserver = createSourcePreserver(source, appendEmpty(trailingParse(source)), trailingTools).preserver!
    const next = appendEmpty(trailingParse('intro\n\n```js\nnew\n```'))
    trailingSerialize.mockClear()
    const result = preserver.prepare(next)
    if ('error' in result) throw new Error(result.error)
    expect(result.source).not.toContain('<br')
    expect(trailingSerialize).toHaveBeenCalledTimes(1)
    expect(trailingSerialize.mock.calls[0][0].childCount).toBe(1)
    result.commit()
    expect(createSourcePreserver(result.source, next, trailingTools).reason).toBeUndefined()
    expect(preserver.prepare(next)).toMatchObject({ source: result.source })
  })

  it('原始显式空段映射进 raw，不当作虚拟尾段吞掉', () => {
    const source = '```js\nold\n```\n\n<br />'
    const doc = trailingParse(source)
    const preserver = createSourcePreserver(source, doc, trailingTools).preserver!
    expect(preserver.prepare(doc)).toMatchObject({ source })
    const changed = preserver.prepare(trailingParse('```js\nnew\n```\n\n<br />'))
    if ('error' in changed) throw new Error(changed.error)
    expect(changed.source.endsWith('\n\n<br />')).toBe(true)
    expect(semanticDoc(trailingParse(changed.source))).toBe(semanticDoc(trailingParse('```js\nnew\n```\n\n<br />')))
    expect(preserver.prepare(appendEmpty(doc))).toHaveProperty('error')
  })

  it('不投影连续空段、非默认属性、marks、hardbreak 或缺失块', () => {
    const source = 'intro\n\n```js\nold\n```'
    const base = trailingParse(source)
    const preserver = createSourcePreserver(source, base, trailingTools).preserver!
    const invalidTails = [
      trailingSchema.node('paragraph', { align: 'right' }),
      trailingSchema.node('paragraph', null, undefined, [trailingSchema.mark('strong')]),
      trailingSchema.node('paragraph', null, [trailingSchema.node('hardbreak')]),
    ]
    for (const tail of invalidTails) {
      const doc = trailingSchema.node('doc', null, [base.child(0), base.child(1), tail])
      expect(createSourcePreserver(source, doc, trailingTools).reason).toBeDefined()
      expect(preserver.prepare(doc)).toHaveProperty('error')
    }
    expect(createSourcePreserver(source, appendEmpty(base, 2), trailingTools).reason).toBeDefined()
    expect(preserver.prepare(appendEmpty(base, 2))).toHaveProperty('error')
    expect(createSourcePreserver(source, appendEmpty(trailingParse('intro')), trailingTools).reason).toBeDefined()
  })

  it('纯排版差异无序列化，派生 heading.id 不改变原文', () => {
    const source = '\n标题\n====\n\n'
    const preserver = setup(source)
    serialize.mockClear()
    const doc = parse('# 标题')
    const next = schema.node('doc', null, [schema.node('heading', { ...doc.child(0).attrs, id: 'derived' })])
    expect(preserver.prepare(next)).toMatchObject({ source })
    expect(serialize).not.toHaveBeenCalled()
  })

  it.each([
    ['段落', 'old', 'new'],
    ['标题', 'old\n===', '# new'],
    ['列表', '* old\n* stay', '* new\n* stay'],
    ['表格', '| a | b |\n| - | - |\n| old | c |', '| a | b |\n| - | - |\n| new | c |'],
    ['代码', '~~~~js\nold\n~~~~', '```js\nnew\n```'],
  ])('仅重写变化%s顶层块', (_name, before, after) => {
    const source = `\r\n# keep 😀\r\n \r\n\r\n${before.replaceAll('\n', '\r\n')}\r\n\r\n~~~~~txt\r\nuntouched\r\n~~~~~\r\n \r\n`
    const preserver = setup(source)
    serialize.mockClear()
    const result = prepare(preserver, `# keep 😀\n\n${after}\n\n~~~txt\nuntouched\n~~~`)
    expect(result.source.startsWith('\r\n# keep 😀\r\n \r\n\r\n')).toBe(true)
    expect(result.source.endsWith('\r\n\r\n~~~~~txt\r\nuntouched\r\n~~~~~\r\n \r\n')).toBe(true)
    expect(serialize).toHaveBeenCalledTimes(1)
    expect(semanticDoc(parse(result.source))).toBe(semanticDoc(parse(`# keep 😀\n\n${after}\n\n~~~txt\nuntouched\n~~~`)))
  })

  it('prepare 不推进快照，commit 后支持初始撤销与 redo', () => {
    const original = '\nold\n\n\nkeep\n '
    const preserver = setup(original)
    const first = prepare(preserver, 'new\n\nkeep')
    const abandoned = prepare(preserver, 'other\n\nkeep')
    expect(prepare(preserver, 'old\n\nkeep').source).toBe(original)
    first.commit()
    expect(() => abandoned.commit()).toThrow('过期')
    const undo = prepare(preserver, 'old\n\nkeep'); undo.commit()
    expect(undo.source).toBe(original)
    expect(prepare(preserver, 'new\n\nkeep').source).toBe(first.source)
  })

  it.each([
    ['one two\n\nkeep', 'one\n\ntwo\n\nkeep'],
    ['one\n\ntwo\n\nkeep', 'one two\n\nkeep'],
    ['one', 'one\n\ntwo'],
    ['', 'new'],
    ['old\n\nkeep', ''],
    ['one\n\nkeep', 'keep'],
  ])('支持 split/merge/插入/删除/空文档：%s', (source, next) => {
    const result = prepare(setup(source), next)
    expect(semanticDoc(parse(result.source))).toBe(semanticDoc(parse(next)))
  })

  it.each(['---\na: b\n---\ntext', '\uFEFF---\r\na: b\r\n---', '+++\r\na=1\r\n+++',
    '```js title\nx\n```', '> ```js title\n> x\n> ```', '[x][id]\n\n[id]: /x', '![x][id]\n\n[id]: /x', '[id]: /x'])('拒绝 PM 无法表达的信息：%s', source => {
    expect(createSourcePreserver(source, parse(source), tools).reason).toMatch(/frontmatter|meta|引用/)
  })

  it('不忽略语言、checked、hardbreak、spread', () => {
    for (const [a, b] of [['```js\nx\n```', '```ts\nx\n```'], ['- [ ] x', '- [x] x'], ['a\nb', 'a  \nb'], ['- a\n- b', '- a\n\n- b']])
      expect(semanticDoc(parse(a))).not.toBe(semanticDoc(parse(b)))
  })

  it('拒绝候选解析语义不符且不全文回退', () => {
    const bad = { ...tools, serialize: vi.fn(() => 'wrong\n') }
    const preserver = createSourcePreserver('old\n\nkeep', parse('old\n\nkeep'), bad).preserver!
    expect(preserver.prepare(parse('new\n\nkeep'))).toHaveProperty('error')
    expect(bad.serialize).toHaveBeenCalledTimes(1)
    expect(prepare(preserver, 'old\n\nkeep').source).toBe('old\n\nkeep')
  })

  it('拒绝重复语义但不同 raw 的身份歧义', () => {
    const preserver = setup('# same\n\nsame\n====\n\nold')
    expect(preserver.prepare(parse('# changed\n\n# same\n\nold'))).toHaveProperty('error')
  })

  it.each(['---\n\n正文\n', '\uFEFF---\r\n\r\n正文\r\n', '---\r\r正文\r'])('普通开头水平线不是 frontmatter：%s', source => {
    const result = prepare(setup(source), '---\n\n修改正文')
    expect(result.source.startsWith(source.slice(0, source.indexOf('正文')))).toBe(true)
    expect(semanticDoc(parse(result.source))).toBe(semanticDoc(parse('---\n\n修改正文')))
  })

  it.each(['---\na: b', '\uFEFF---\r\ntitle: draft\r\n', '+++\r\na=1',
    '---\n\nmetadata\n---\n', '---\r\na: b\r\n...\r\nbody'])('保护闭合或未闭合 metadata 候选：%s', source => {
    expect(createSourcePreserver(source, parse(source), tools).reason).toMatch(/frontmatter/)
  })

  it.each([
    '* first\n\n- second\n\n+ third\n\nold',
    '* same\n\n- same\n\n+ same\n\nold',
  ])('不同顶层列表 marker 保留，允许编辑别段：%s', source => {
    const preserver = setup(source)
    serialize.mockClear()
    const result = prepare(preserver, source.replace(/old$/, 'new'))
    expect(result.source).toBe(source.replace(/old$/, 'new'))
    expect(serialize).toHaveBeenCalledTimes(1)
  })

  it('修改混合 marker 的单个列表仅规范化该容器', () => {
    const source = '* first\n\n- second\n\n+ third\n\nkeep'
    const next = '* first\n\n- changed\n\n+ third\n\nkeep'
    // 默认星号会与前一个列表合并，必须拒绝，不能重写相邻容器。
    expect(setup(source).prepare(parse(next))).toHaveProperty('error')
    const dash = unified().use(remarkGfm).use(remarkStringify, { bullet: '-' })
    const compatible = { ...tools, serialize: (doc: PMNode) => dash.stringify({ type: 'root', children: [doc.child(0).attrs.tree] } as Root) }
    const preserver = createSourcePreserver(source, parse(source), compatible).preserver!
    const result = prepare(preserver, next)
    expect(result.source.startsWith('* first\n\n')).toBe(true)
    expect(result.source.endsWith('\n\n+ third\n\nkeep')).toBe(true)
    expect(semanticDoc(parse(result.source))).toBe(semanticDoc(parse('* first\n\n- changed\n\n+ third\n\nkeep')))
  })

  it('多次预检不占历史预算，只有被选中的 candidate 可提交', () => {
    const preserver = setup('old')
    for (let i = 0; i < 60; i++) prepare(preserver, `abandoned ${i}`)
    const candidate = prepare(preserver, 'new')
    expect(prepare(preserver, 'old').source).toBe('old')
    candidate.commit()
    expect(prepare(preserver, 'new').source).toBe(candidate.source)
    expect(() => candidate.commit()).toThrow('过期')
  })

  it.each(['', '\n', '\r\n'])('唯一块 A B C → A C B 复用 raw，保留旧 gap 并支持精确撤销：%s', tail => {
    const source = `\nA\n\n\nB\n \n\nC${tail}`
    const preserver = setup(source)
    serialize.mockClear()
    const moved = prepare(preserver, 'A\n\nC\n\nB')
    expect(semanticDoc(parse(moved.source))).toBe(semanticDoc(parse('A\n\nC\n\nB')))
    expect(moved.source.startsWith('\nA\n\n\n\n \n\nC')).toBe(true)
    expect(moved.source.endsWith('B')).toBe(true)
    expect(serialize).not.toHaveBeenCalled()
    moved.commit()
    const undo = prepare(preserver, 'A\n\nB\n\nC')
    expect(undo.source).toBe(source)
    undo.commit()
    expect(prepare(preserver, 'A\n\nC\n\nB').source).toBe(moved.source)
    expect(serialize).not.toHaveBeenCalled()
  })

  it('真实拖拽回归样例保留旧 gaps，保存候选与失败现场一致且可精确撤销重做', () => {
    const original = '# 标题\n\n第一段\n\n第二段\n\n第三段\n'
    const preserver = setup(original)
    serialize.mockClear()
    const target = '# 标题\n\n第一段\n\n第三段\n\n第二段\n'
    const moved = prepare(preserver, target)
    // 移出第二段后的两个 gap 合并；旧尾部 LF 保留，新末块前只补足分隔。
    expect(moved.source).toBe('# 标题\n\n第一段\n\n\n\n第三段\n\n第二段')
    expect(semanticDoc(parse(moved.source))).toBe(semanticDoc(parse(target)))
    const raw = ast(moved.source).children.map(block => moved.source.slice(block.position!.start.offset!, block.position!.end.offset!))
    expect(raw).toEqual(['# 标题', '第一段', '第三段', '第二段'])
    expect(moved.source.match(/\n/g)!.length).toBeGreaterThanOrEqual(original.match(/\n/g)!.length)
    expect(serialize).not.toHaveBeenCalled()
    moved.commit()
    const undo = prepare(preserver, original)
    expect(undo.source).toBe(original)
    undo.commit()
    const redo = prepare(preserver, target)
    expect(redo.source).toBe(moved.source)
    redo.commit()
    expect(serialize).not.toHaveBeenCalled()
  })

  it('移动和重复插入同 key 同 raw 的块无需 serialize', () => {
    const source = 'A\n\nB\n\nA\n\nC'
    const preserver = setup(source)
    serialize.mockClear()
    const next = 'A\n\nC\n\nB\n\nA\n\nA'
    const result = prepare(preserver, next)
    expect(semanticDoc(parse(result.source))).toBe(semanticDoc(parse(next)))
    expect(serialize).not.toHaveBeenCalled()
  })

  it('移动代码块复用长 fence 和原始换行，不规范化 raw', () => {
    const source = 'A\r\n\r\n~~~~~js\r\nx\r\n~~~~~\r\n\r\nC\r\n'
    const preserver = setup(source)
    serialize.mockClear()
    const result = prepare(preserver, 'A\n\nC\n\n```js\nx\n```')
    expect(result.source.endsWith('~~~~~js\r\nx\r\n~~~~~')).toBe(true)
    expect(semanticDoc(parse(result.source))).toBe(semanticDoc(parse('A\n\nC\n\n```js\nx\n```')))
    expect(serialize).not.toHaveBeenCalled()
  })

  it('不同 raw 的重复语义块跨变化范围移动仍拒绝', () => {
    const preserver = setup('# same\n\nsame\n====\n\nC')
    serialize.mockClear()
    expect(preserver.prepare(parse('# same\n\nC\n\n# same'))).toMatchObject({ error: expect.stringContaining('身份') })
    expect(serialize).not.toHaveBeenCalled()
  })

  it('空段落不可表示时拒绝，而非 trim 或丢弃', () => {
    const preserver = setup('old')
    const doc = schema.node('doc', null, [parse('old').child(0), schema.node('paragraph', { tree: { type: 'paragraph', children: [] } })])
    expect(preserver.prepare(doc)).toHaveProperty('error')
    expect(prepare(preserver, 'old').source).toBe('old')
  })

  it('逐块验证而非只比块数量', () => {
    const source = 'old\n\nkeep'
    const bad = { ...tools, parse: (text: string) => parse(text === 'old' ? 'wrong' : text) }
    expect(createSourcePreserver(source, parse(source), bad).reason).toMatch(/独立块/)
  })

  it('150 次逐键编辑滚动历史，不阻塞输入并精确恢复初始原文', () => {
    const original = '\ninitial\r\n\r\n~~~~txt\r\nkeep\r\n~~~~\r\n '
    const preserver = setup(original)
    const cache = preserver as unknown as { history: { source: string }[]; bytes: number }
    let latest = original
    for (let i = 1; i <= 150; i++) {
      const before = [...cache.history]
      const result = prepare(preserver, `initial${'x'.repeat(i)}\n\n~~~txt\nkeep\n~~~`)
      expect(cache.history).toEqual(before)
      result.commit()
      latest = result.source
      expect(cache.history.length).toBeLessThanOrEqual(50)
      expect(cache.bytes).toBeLessThanOrEqual(16 * 1024 * 1024)
      expect(cache.history[0].source).toBe(original)
      expect(cache.history.at(-1)?.source).toBe(latest)
      expect(latest.endsWith('\r\n\r\n~~~~txt\r\nkeep\r\n~~~~\r\n ')).toBe(true)
    }
    expect(cache.history.some(snapshot => snapshot.source.includes(`initialx\r`))).toBe(false)
    expect(prepare(preserver, `initial${'x'.repeat(150)}\n\n~~~txt\nkeep\n~~~`).source).toBe(latest)
    const undo = prepare(preserver, 'initial\n\n~~~txt\nkeep\n~~~')
    expect(undo.source).toBe(original)
    undo.commit()
    expect(prepare(preserver, `initial${'x'.repeat(150)}\n\n~~~txt\nkeep\n~~~`).source).toBe(latest)
    // 被淘汰的语义仍可重新生成，未变代码块继续逐字符复用。
    const evicted = prepare(preserver, 'initialx\n\n~~~txt\nkeep\n~~~')
    expect(semanticDoc(parse(evicted.source))).toBe(semanticDoc(parse('initialx\n\n~~~txt\nkeep\n~~~')))
    expect(evicted.source.endsWith('\r\n\r\n~~~~txt\r\nkeep\r\n~~~~\r\n ')).toBe(true)
    evicted.commit()
  })

  it('接近单快照 8 MiB 时按总字节滚动，仅保留初始与当前也可继续编辑', () => {
    const padding = 'x'.repeat(2_096_000)
    const largeParse = (source: string) => schema.node('doc', null,
      source ? [schema.node('paragraph', { tree: { value: source, padding: source === 'oversized' ? padding + 'x'.repeat(4000) : padding } })] : [])
    const largeTools = {
      parse: largeParse,
      serialize: (doc: PMNode) => doc.child(0).attrs.tree.value as string,
      ast: (source: string) => ({ type: 'root', children: source ? [{ type: 'paragraph', position: { start: { offset: 0 }, end: { offset: source.length } } }] : [] }),
    }
    const initial = createSourcePreserver('initial', largeParse('initial'), largeTools)
    expect(initial.reason).toBeUndefined()
    const preserver = initial.preserver!
    const cache = preserver as unknown as { history: { source: string }[]; bytes: number }
    expect(cache.bytes).toBeGreaterThan(8 * 1024 * 1024 - 16_384)
    expect(cache.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    for (let i = 0; i < 5; i++) {
      const before = [...cache.history], bytes = cache.bytes
      const result = preserver.prepare(largeParse(`change ${i}`))
      expect(cache.history).toEqual(before)
      expect(cache.bytes).toBe(bytes)
      if ('error' in result) throw new Error(result.error)
      result.commit()
      expect(cache.history.map(snapshot => snapshot.source)).toEqual(['initial', `change ${i}`])
      expect(cache.bytes).toBeLessThanOrEqual(16 * 1024 * 1024)
      expect(preserver.prepare(largeParse(`change ${i}`))).toMatchObject({ source: `change ${i}` })
    }
    const before = [...cache.history], bytes = cache.bytes
    expect(preserver.prepare(largeParse('oversized'))).toMatchObject({ error: expect.stringContaining('单快照 8 MiB') })
    expect(cache.history).toEqual(before)
    expect(cache.bytes).toBe(bytes)
    expect(createSourcePreserver('oversized', largeParse('oversized'), largeTools).reason).toMatch(/单快照 8 MiB/)
    expect(preserver.prepare(largeParse('initial'))).toMatchObject({ source: 'initial' })
    expect(preserver.prepare(largeParse('change 4'))).toMatchObject({ source: 'change 4' })
  })

  it('资源超限与解析异常明确拒绝', () => {
    expect(createSourcePreserver('a'.repeat(1_000_001), parse('a'), tools).reason).toMatch(/限制/)
    expect(createSourcePreserver('\n'.repeat(20_000), parse(''), tools).reason).toMatch(/限制/)
    expect(createSourcePreserver('a', parse('a'), { ...tools, ast: () => { throw new Error('AST 故障') } }).reason).toBe('AST 故障')
  })

  it('BOM、emoji 的 UTF-16 区间与删除后的旧 gap 保留', () => {
    const source = '\uFEFF# 😀\r\n\r\n\r\nold\r\n \r\n\r\nkeep\r\n'
    const result = prepare(setup(source), '# 😀\n\nkeep')
    expect(result.source).toBe('\uFEFF# 😀\r\n\r\n\r\n\r\n \r\n\r\nkeep\r\n')
  })

  it('LCS 超预算明确拒绝', () => {
    const before = Array.from({ length: 500 }, (_, i) => `old ${i}`).join('\n\n')
    const after = Array.from({ length: 500 }, (_, i) => `new ${i}`).join('\n\n')
    expect(setup(before).prepare(parse(after))).toMatchObject({ error: expect.stringContaining('LCS') })
  })
})
