import { describe, expect, it } from 'vitest'
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import { createMathRenderer, mathDecorations } from './math-preview'
import { mathMarkdown } from './math-syntax'
import { markdownLinkAt } from './links'

const stateFor = (doc: string) => {
  const state = EditorState.create({ doc, extensions: markdown({ base: commonmarkLanguage, extensions: [GFM, mathMarkdown] }) })
  ensureSyntaxTree(state, state.doc.length, 100)
  return state
}
const widgets = (state: EditorState) => {
  const result: { from: number; to: number; source: string; display: boolean; block: boolean }[] = []
  mathDecorations(state, createMathRenderer()).between(0, state.doc.length, (from, to, value) => { result.push({ from, to, source: value.spec.widget.source, display: value.spec.widget.display, block: value.spec.block }) })
  return result
}

describe('公式原文预览', () => {
  it('矩阵等号行和 LaTeX 反斜杠完整交给 KaTeX，不先转成 Markdown', async () => {
    const source = String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}
\begin{pmatrix} x \\ y \end{pmatrix}
=
\begin{pmatrix} ax+by \\ cx+dy \end{pmatrix}`
    const doc = `光标\n\n$$\n${source}\n$$\n\n尾部`
    const result = widgets(stateFor(doc))
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe(source)
    expect(result[0].display).toBe(true)
    expect(doc.slice(result[0].from, result[0].to)).toBe(`$$\n${source}\n$$`)
    const html = await createMathRenderer().render(result[0].source, true)
    expect(html).toContain('class="katex"')
    expect(html).toContain('<mtable')
  })

  it('保留 CodeMirror Markdown 包裹解析器时补闭合与撤回均重新识别', () => {
    const body = 'x+y\n=\n' + 'x+'.repeat(200) + 'y'
    const doc = '前文\n\n'.repeat(80) + `$$\n${body}\n\n尾部`
    const before = stateFor(doc)
    expect(widgets(before)).toEqual([])
    const from = doc.lastIndexOf('\n\n尾部') + 1
    const after = before.update({ changes: { from, insert: '$$\n' }, selection: { anchor: 0 } }).state
    ensureSyntaxTree(after, after.doc.length, 100)
    expect(widgets(after).map(widget => widget.source)).toEqual([body])
    const restored = after.update({ changes: { from, to: from + 3 } }).state
    ensureSyntaxTree(restored, restored.doc.length, 100)
    expect(widgets(restored)).toEqual([])
    expect(restored.doc.toString()).toBe(doc)
  })

  it('仅装饰公式并保留金额、转义和混合上下文', () => {
    const doc = '光标\n\n价格 $5 和 $10，成对金额 $20$。\n\n公式 $E=mc^2$。\n\n$$\n\\frac{a}{b}\n$$\n\n尾部'
    const state = stateFor(doc), result = widgets(state)
    expect(result.map(item => [item.source, item.display, !!item.block])).toEqual([['E=mc^2', false, false], ['\\frac{a}{b}', true, true]])
    expect(state.sliceDoc(result[0].from, result[0].to)).toBe('$E=mc^2$')
    expect(state.doc.toString()).toBe(doc)
  })
  it('活动行与跨块选区恢复源码，不影响文档与撤销', () => {
    const doc = '光标\n\n$x^2$ 和 $y^2$\n\n$$\nx+y\n$$\n\n尾部', state = stateFor(doc)
    expect(widgets(state)).toHaveLength(3)
    expect(widgets(state.update({ selection: { anchor: doc.indexOf('x^2') } }).state)).toHaveLength(1)
    expect(widgets(state.update({ selection: { anchor: doc.indexOf('x+y') } }).state)).toHaveLength(2)
    const all = state.update({ selection: { anchor: 0, head: doc.length } }).state
    expect(widgets(all)).toHaveLength(0)
    expect(all.doc.toString()).toBe(doc)
  })
  it('代码、HTML 和表格单元格中的公式不挂载预览', () => {
    const doc = '光标\n\n`$x$`\n\n```text\n$x$\n```\n\n    $x$\n\n<div>$x$</div>\n\n| H |\n| --- |\n| $x$ |\n'
    expect(widgets(stateFor(doc))).toHaveLength(0)
  })
  it('公式内的伪 Markdown 链接不能跳转', () => {
    for (const source of ['$[伪链接](./secret.md)$', '$$\n[伪链接](./secret.md)\n$$']) expect(markdownLinkAt(source, source.indexOf('伪链接'))).toBeUndefined()
  })
})

describe('安全 KaTeX 渲染与缓存', () => {
  it.each([
    ['E=mc^2', false], ['\\frac{a}{b}+\\sqrt{x}', false],
    ['\\sum_{i=1}^{n}i', true], ['\\int_0^1 x^2\\,dx', true],
    ['\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', true],
  ])('支持常见公式 %s 并输出可访问 MathML', async (source, display) => {
    const html = await createMathRenderer().render(source, display)
    expect(html).toContain('class="katex"')
    expect(html).toContain('<math')
    expect(html).not.toMatch(/<(?:script|iframe|img)\b/)
  })
  it.each(['\\href{javascript:alert(1)}{x}', '\\url{https://evil.test}', '\\includegraphics{https://evil.test/x.png}', '\\htmlClass{evil}{x}', '\\htmlStyle{background:url(https://evil.test)}{x}', '\\require{html}'])('拒绝活动命令 %s', async source => {
    await expect(async () => createMathRenderer().render(source, false)).rejects.toThrow('不支持')
  })
  it('语法错误、循环宏和过长公式明确失败，宏不跨公式共享', async () => {
    const renderer = createMathRenderer()
    await expect(async () => renderer.render('\\frac{', false)).rejects.toThrow()
    await expect(async () => renderer.render('\\def\\a{\\a}\\a', false)).rejects.toThrow()
    await expect(async () => renderer.render('x'.repeat(4001), false)).rejects.toThrow('长度')
    await renderer.render('\\gdef\\localMacro{x}\\localMacro', false)
    await expect(async () => renderer.render('\\localMacro', false)).rejects.toThrow()
  })
  it('成功结果按源码及显示模式缓存，实例间不共享，超条数淘汰', async () => {
    const renderer = createMathRenderer(), initial = await renderer.render('x^2', false)
    expect(renderer.render('x^2', false)).toBe(initial)
    expect(renderer.render('x^2', true)).toBeInstanceOf(Promise)
    expect(createMathRenderer().render('x^2', false)).toBeInstanceOf(Promise)
    for (let index = 0; index < 65; index++) await renderer.render(`y_{${index}}`, false)
    const evicted = renderer.render('x^2', false)
    expect(evicted).toBeInstanceOf(Promise)
    await evicted
  })
  it('类 HTML 文本只能成为转义文本，不生成活动标签', async () => {
    const html = await createMathRenderer().render('\\text{<img src=x onerror=alert(1)>}', false)
    expect(html).not.toMatch(/<img\b|<script\b|<[^>]+\sonerror=/)
    expect(html).toContain('&lt;')
  })
})
