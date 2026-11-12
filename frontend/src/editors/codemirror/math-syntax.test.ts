import { describe, expect, it } from 'vitest'
import { GFM, parser } from '@lezer/markdown'
import { getStyleTags, tags } from '@lezer/highlight'
import { TreeFragment } from '@lezer/common'
import { EditorState } from '@codemirror/state'
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { mathMarkdown } from './math-syntax'

const mathParser = parser.configure([GFM, mathMarkdown])

function nodes(source: string, name: string) {
  const result: { from: number, to: number, text: string }[] = []
  mathParser.parse(source).iterate({
    enter(node) {
      if (node.name === name) result.push({ from: node.from, to: node.to, text: source.slice(node.from, node.to) })
    },
  })
  return result
}

describe('公式语法：内联边界与金额保护', () => {
  it.each([
    '$5', '$10', '$9.99', '价格 $5 / $10 / $9.99',
    '$20$', '$1,234.50$', '$9.99$', '$-20$', '$.50$', '$100%$', '$20元$', '$20 USD$',
    String.raw`\$x$`, String.raw`\$5 和 \$10`,
    '$ x$', '$x $', '$\tx$', '$x\t$', '$x\ny$', '$x\r\ny$',
    '$$', '$$x$$', '$$$x$$$', '$x$2', '$x$$', '$x',
    '$5 dollars$', '$5 per item$', '$5 \\alpha dollars$',
    '$x$5 more$',
  ])('不误认金额或非法边界：%s', (source) => {
    expect(nodes(source, 'InlineMath')).toEqual([])
  })

  it.each(['$2+2$', '$2x$', '$E=mc^2$', '$x$', '$2 \\times x$', '$2 \\alpha$', '$5 \\text{dollars}$', String.raw`$x+\$y$`, String.raw`$x+\\$`])('识别表达式：%s', (source) => {
    expect(nodes(source, 'InlineMath')).toEqual([{ from: 0, to: source.length, text: source }])
  })

  it('拒绝价格描述后仍识别独立公式，不跨越第一个非法闭合符', () => {
    expect(nodes('$5 and$x$', 'InlineMath').map(node => node.text)).toEqual(['$x$'])
    expect(nodes('$x $later$', 'InlineMath').map(node => node.text)).toEqual(['$later$'])
  })
  it.each(['$20$+$x$', '$20$和$x$', '$20$，公式$E=mc^2$', '$20元$和$x$', '收费$20元，折算公式$x$'])('成对金额的闭合符不抢占相邻公式：%s', source => {
    const expected = source.endsWith('$E=mc^2$') ? '$E=mc^2$' : '$x$'
    expect(nodes(source, 'InlineMath').map(node => node.text)).toEqual([expected])
  })

  it('按反斜杠奇偶处理转义，保留原文位置', () => {
    const source = String.raw`前文 \\$x$ 后文 $a\$b$`
    expect(nodes(source, 'InlineMath').map(node => node.text)).toEqual(['$x$', String.raw`$a\$b$`])
    expect(nodes('前文 $x$ 和 $y$', 'MathMark').map(node => node.from)).toEqual([3, 5, 9, 11])
  })

  it('4000 字符以内识别，超限不识别', () => {
    expect(nodes(`$${'x'.repeat(3998)}$`, 'InlineMath')).toHaveLength(1)
    expect(nodes(`$${'x'.repeat(3999)}$`, 'InlineMath')).toEqual([])
  })
})

describe('公式语法：隔离与节点 API', () => {
  it.each([
    '`$x$`', '``$x$``', '```math\n$x$\n$$\ny\n$$\n```',
    '~~~\n$x$\n~~~', '    $x$', '    $$\n    x\n    $$',
    '<span title="$x$">标签</span>', '<div data-math="$x$">\n$$\nx\n$$\n</div>',
    '<!-- $x$ -->', '<?test $x$ ?>',
  ])('代码与 HTML 不产生公式节点：%s', (source) => {
    expect(nodes(source, 'InlineMath')).toEqual([])
    expect(nodes(source, 'MathBlock')).toEqual([])
  })

  it('HTML 标签外仍可识别，公式内容不再按 Markdown 解析', () => {
    expect(nodes('<span title="$a$">$x$</span>', 'InlineMath').map(node => node.text)).toEqual(['$x$'])
    const tree = mathParser.parse('$*x* + [y](url) + `z`$')
    expect(tree.toString()).toBe('Document(Paragraph(InlineMath(MathMark,MathMark)))')
    const mark = tree.topNode.firstChild!.firstChild!.firstChild!
    expect(getStyleTags(mark)?.tags).toContain(tags.processingInstruction)
  })

  it('仅解析语法树，不改写编辑器源文本', () => {
    const source = '前文 \\$5 与 $2+2$\n\n$$\nE=mc^2\nx_1 + *y*\n$$\n\n后文'
    const state = EditorState.create({ doc: source, extensions: markdown({ base: commonmarkLanguage, extensions: [GFM, mathMarkdown] }) })
    expect(syntaxTree(state).toString()).toContain('MathBlock(MathMark,MathMark)')
    expect(state.doc.toString()).toBe(source)
    const updated = state.update({ changes: { from: source.indexOf('x_1'), insert: '=\n' } }).state
    expect(syntaxTree(updated).toString()).toContain('MathBlock(MathMark,MathMark)')
    expect(updated.doc.toString()).toBe(source.replace('x_1', '=\nx_1'))
  })
})

describe('公式语法：顶层显示公式', () => {
  it('矩阵公式中的独立等号不被识别为 Setext 标题', () => {
    const body = String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}
\begin{pmatrix} x \\ y \end{pmatrix}
=
\begin{pmatrix} ax+by \\ cx+dy \end{pmatrix}`
    const source = `前文\n\n$$\n${body}\n$$\n\n后文`
    expect(nodes(source, 'MathBlock').map(node => node.text)).toEqual([`$$\n${body}\n$$`])
    expect(nodes(source, 'SetextHeading1')).toEqual([])
    expect(nodes(source, 'SetextHeading2')).toEqual([])
  })

  it('识别连续多行，标记范围准确，前后段落不被吞并', () => {
    const source = '前文\n$$\nE=mc^2\nx_1 + *y*\n$$\n后文 $z$'
    expect(nodes(source, 'MathBlock')).toEqual([{ from: 3, to: 25, text: '$$\nE=mc^2\nx_1 + *y*\n$$' }])
    expect(nodes(source, 'MathMark').map(node => node.text)).toEqual(['$$', '$$', '$', '$'])
    expect(nodes(source, 'Paragraph').map(node => node.text)).toEqual(['前文', '后文 $z$'])
    expect(nodes(source, 'Emphasis')).toEqual([])
  })

  it('允许最多三空格缩进及边界尾部空白', () => {
    const source = '  $$ \t\nx+y\n   $$\t'
    expect(nodes(source, 'MathBlock')).toHaveLength(1)
    expect(nodes(source, 'MathMark').map(node => node.text)).toEqual(['$$', '$$'])
  })

  it.each([
    'x\n=', 'x\n---', '| a | b |\n| --- | --- |\n| x | y |',
    String.raw`\left[\begin{matrix} a & b \\ c & d \end{matrix}\right]
\text{[label](url)} + *x* + \alpha`,
    '# 标题\n> 引用\n- 列表\n```js\n<div>HTML</div>\n```',
  ])('有效块内的 Markdown 样式内容保持不透明：%s', body => {
    const source = `$$\n${body}\n$$`
    expect(mathParser.parse(source).toString()).toBe('Document(MathBlock(MathMark,MathMark))')
    expect(nodes(source, 'MathBlock')).toEqual([{ from: 0, to: source.length, text: source }])
  })

  it('相邻块独立闭合，未闭合尾块不吞后续标题', () => {
    const source = '$$\nx\n$$\n  $$\ny\n   $$\n$$\nz\n# 后文'
    expect(nodes(source, 'MathBlock').map(node => node.text)).toEqual(['$$\nx\n$$', '$$\ny\n   $$'])
    expect(nodes(source, 'ATXHeading1').map(node => node.text)).toEqual(['# 后文'])
  })

  it('CRLF 保留原始偏移；孤立 CR 不作为 Lezer 的换行符', () => {
    const source = '前文\r\n  $$\t\r\nx\r\n=\r\n   $$ \r\n后文'
    const from = source.indexOf('$$')
    const close = source.lastIndexOf('$$')
    const to = source.indexOf('\n后文')
    expect(nodes(source, 'MathBlock')).toEqual([{ from, to, text: source.slice(from, to) }])
    expect(nodes(source, 'MathMark').map(node => [node.from, node.to])).toEqual([[from, from + 2], [close, close + 2]])
    expect(nodes('$$\rx\r$$', 'MathBlock')).toEqual([])
    expect(nodes('$$\r\nx\r\n \t\r\n$$', 'MathBlock')).toEqual([])
  })

  it('CRLF 与缩进均计入块预算，截断的闭合行不能提前确认', () => {
    expect(nodes(`   $$\r\n${'x'.repeat(19992)}\r\n$$`, 'MathBlock')).toHaveLength(1)
    for (const source of [
      `$$\r\n${'x'.repeat(19993)}\r\n$$\n\n# 后文`,
      `$$\n${'x'.repeat(19994)}\n$$ extra\n\n# 后文`,
      `$$\n${'x'.repeat(19994)}\n$$ \n\n# 后文`,
    ]) {
      expect(nodes(source, 'MathBlock')).toEqual([])
      expect(nodes(source, 'ATXHeading1').map(node => node.text)).toEqual(['# 后文'])
    }
  })

  it('失败前瞻与普通 Markdown 一致，不跨空行寻找闭合符', () => {
    const ordinaryParser = parser.configure(GFM)
    for (const source of ['$$\nx\n=\n# 后文', '$$\nx\n---\n\n$$', '$$\nx\n \t\n$$\n# 后文']) {
      expect(mathParser.parse(source).toString()).toBe(ordinaryParser.parse(source).toString())
      expect(mathParser.parse(source).length).toBe(source.length)
    }
  })

  it('前瞻仅读取 parse ranges，跨排除区间仍保留节点的原文位置', () => {
    const source = '忽略\n$$\nx\n排除\n=\n$$\n后文'
    const from = source.indexOf('$$')
    const gapFrom = source.indexOf('排除')
    const gapTo = source.indexOf('=')
    const close = source.lastIndexOf('$$')
    const tree = mathParser.parse(source, [], [{ from, to: gapFrom }, { from: gapTo, to: source.length }])
    expect(tree.toString()).toBe('Document(MathBlock(MathMark,MathMark),Paragraph)')
    expect(tree.topNode.firstChild!.from + from).toBe(from)
    expect(tree.topNode.firstChild!.to + from).toBe(close + 2)
    expect(mathParser.parse(source, [], [{ from, to: close }]).toString()).not.toContain('MathBlock')
    const excludedClose = '$$\nx\n$$\n# 后文'
    expect(mathParser.parse(excludedClose, [], [{ from: 0, to: 5 }, { from: 8, to: excludedClose.length }]).toString()).not.toContain('MathBlock')
  })

  it('fragment 增量修改闭合符、空行和预算时与完整解析一致', () => {
    const source = '前文\n\n$$\nx\n=\n$$\n\n# 后文'
    const tree = mathParser.parse(source)
    for (const [from, to, insert] of [
      [source.lastIndexOf('$$'), source.lastIndexOf('$$') + 2, '$'],
      [source.indexOf('='), source.indexOf('='), '\n'],
      [source.indexOf('x'), source.indexOf('x') + 1, 'y'.repeat(20000)],
      [source.indexOf('='), source.indexOf('=') + 1, '---'],
    ] as const) {
      const updated = source.slice(0, from) + insert + source.slice(to)
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }], 0)
      const incremental = mathParser.parse(updated, fragments)
      const full = mathParser.parse(updated)
      expect(incremental.toString()).toBe(full.toString())
      const positions = (parsed: typeof tree) => {
        const result: string[] = []
        parsed.iterate({ enter(node) { result.push(`${node.name}:${node.from}:${node.to}`) } })
        return result
      }
      expect(positions(incremental)).toEqual(positions(full))
    }
    const unclosed = `${'前文\n\n'.repeat(6000)}$$\nx\n# 标题\n${'正文\n'.repeat(100)}末尾`
    const updated = `${unclosed}\n$$`
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(mathParser.parse(unclosed)), [{ fromA: unclosed.length, toA: unclosed.length, fromB: unclosed.length, toB: updated.length }], 0)
    expect(mathParser.parse(updated, fragments).toString()).toBe(mathParser.parse(updated).toString())
  })

  it('多 ranges 的增量前瞻依赖不按被排除原文的长度截短', () => {
    const source = `$$\nx\n# 标题\n${'排除'.repeat(20000)}正文`
    const gapFrom = source.indexOf('排除')
    const gapTo = source.indexOf('正文')
    const oldRanges = [{ from: 0, to: gapFrom }, { from: gapTo, to: source.length }]
    const tree = mathParser.parse(source, [], oldRanges)
    const updated = `${source}\n$$`
    const ranges = [{ from: 0, to: gapFrom }, { from: gapTo, to: updated.length }]
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: source.length, toA: source.length, fromB: source.length, toB: updated.length }], 0)
    const full = mathParser.parse(updated, [], ranges)
    expect(full.toString()).toContain('MathBlock')
    expect(mathParser.parse(updated, fragments, ranges).toString()).toBe(full.toString())
  })

  it('公共 Input.read 的数学前瞻有界，不读取整份正文', () => {
    const source = `   $$\nx\n$$\n\n${'后文'.repeat(30000)}`
    const reads: number[] = []
    const input = {
      length: source.length,
      lineChunks: false,
      chunk: (from: number) => source.slice(from),
      read(from: number, to: number) {
        reads.push(to - from)
        return source.slice(from, to)
      },
    }
    expect(mathParser.parse(input).toString()).toContain('MathBlock')
    expect(reads).toEqual([20004])
  })

  it('交错 PartialParse 与外层 wrapper 不串用输入，stopAt 继续委托', () => {
    const wrappedParser = mathParser.configure({ wrap(inner) {
      return {
        advance: () => inner.advance(),
        get parsedPos() { return inner.parsedPos },
        get stoppedAt() { return inner.stoppedAt },
        stopAt(pos) { inner.stopAt(pos) },
      }
    } })
    const valid = wrappedParser.startParse('前文\n\n$$\nx\n=\n$$')
    const invalid = wrappedParser.startParse('前文\n\n$$\nx\n=')
    expect(valid.advance()).toBeNull()
    expect(invalid.advance()).toBeNull()
    let validTree = valid.advance()
    let invalidTree = invalid.advance()
    while (!validTree) validTree = valid.advance()
    while (!invalidTree) invalidTree = invalid.advance()
    expect(validTree.toString()).toContain('MathBlock')
    expect(invalidTree.toString()).not.toContain('MathBlock')
    const stopped = wrappedParser.startParse('前文\n\n$$\nx\n$$')
    stopped.stopAt(0)
    expect(stopped.stoppedAt).toBe(0)
    let stoppedTree = stopped.advance()
    while (!stoppedTree) stoppedTree = stopped.advance()
    expect(stoppedTree.toString()).not.toContain('MathBlock')
  })

  it('CodeMirror 混合解析 wrapper 下补闭合符也会使旧段落失效', () => {
    const source = `$$\nx\n# 标题\n${'正文\n'.repeat(100)}末尾`
    const state = EditorState.create({ doc: source, extensions: markdown({ base: commonmarkLanguage, extensions: [GFM, mathMarkdown] }) })
    expect(syntaxTree(state).toString()).not.toContain('MathBlock')
    const updated = state.update({ changes: { from: source.length, insert: '\n$$' } }).state
    expect(syntaxTree(updated).toString()).toBe('Document(MathBlock(MathMark,MathMark))')
    expect(updated.doc.toString()).toBe(`${source}\n$$`)
    const reverted = updated.update({ changes: { from: source.length, to: updated.doc.length } }).state
    expect(syntaxTree(reverted).toString()).toBe(syntaxTree(state).toString())
    expect(reverted.doc.toString()).toBe(source)
  })

  it.each([
    '$$\nx+y', '$$\nx+y\n\n后文', '$$\nx+y\n\n$$',
    '> $$\n> x+y\n> $$', '- $$\n  x+y\n  $$',
    '$$x+y$$', '$$ extra\nx+y\n$$', '$$\nx+y\n    $$',
  ])('未闭合、空行、嵌套或非独立边界保留默认解析：%s', (source) => {
    expect(nodes(source, 'MathBlock')).toEqual([])
    expect(mathParser.parse(source).length).toBe(source.length)
  })

  it('未闭合时后续段落、标题和代码仍按 Markdown 解析', () => {
    const source = '$$\nx+y\n\n后文\n\n# 标题\n\n```\n代码\n```'
    expect(nodes(source, 'Paragraph').map(node => node.text)).toEqual(['$$\nx+y', '后文'])
    expect(nodes(source, 'ATXHeading1')).toHaveLength(1)
    expect(nodes(source, 'FencedCode')).toHaveLength(1)
  })

  it('20000 字符以内识别，超限保留原文且不吞相邻段落', () => {
    expect(nodes(`$$\n${'x'.repeat(19994)}\n$$`, 'MathBlock')).toHaveLength(1)
    const source = `$$\n${'x'.repeat(19995)}\n$$\n\n后文`
    expect(nodes(source, 'MathBlock')).toEqual([])
    expect(nodes(source, 'Paragraph').at(-1)?.text).toBe('后文')
  })
})
