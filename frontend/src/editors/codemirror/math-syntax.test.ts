import { describe, expect, it } from 'vitest'
import { GFM, parser } from '@lezer/markdown'
import { getStyleTags, tags } from '@lezer/highlight'
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
  })
})

describe('公式语法：顶层显示公式', () => {
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
