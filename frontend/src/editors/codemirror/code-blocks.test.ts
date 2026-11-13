import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ensureSyntaxTree, LanguageDescription, syntaxTree } from '@codemirror/language'
import { markdown, commonmarkLanguage } from '@codemirror/lang-markdown'
import { highlightTree } from '@lezer/highlight'
import type { SyntaxNode } from '@lezer/common'
import { expect, it, vi } from 'vitest'
import { codeLanguage, createCodeLanguages } from './code-languages'
import { codeBlockControls, fencedCodeText } from './code-blocks'
import { preserveLineEndings } from './line-endings'
import { codeHighlightStyle, rainbowBracketDecorations, codeTheme } from '../theme'

it('容器代码块只隐藏围栏，原文与容器结构不变', () => {
  const source = '前文\n\n> ```js\n> code\n> ```\n\n尾部'
  const state = EditorState.create({ doc: source, extensions: [markdown({ base: commonmarkLanguage }), codeBlockControls({ slice: (state, from, to) => state.sliceDoc(from, to) })] })
  expect(hiddenFences(state).map(range => state.sliceDoc(range.from, range.to))).toEqual(['```js', '> ```'])
  expect(state.doc.toString()).toBe(source)
})

function hiddenFences(state: EditorState) {
  const ranges: { from: number; to: number; block: boolean }[] = []
  for (const decorations of state.facet(EditorView.decorations)) {
    if (typeof decorations === 'function') continue
    decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (!decoration.spec.class && !decoration.spec.widget && from < to) ranges.push({ from, to, block: !!decoration.spec.block })
    })
  }
  return ranges
}

for (const [opening, closing] of [['```json', '```'], ['~~~~py filename="keep.py"', '~~~~'], ['```', '```']]) {
  it(`完整代码块 ${opening} 非活动时隐藏围栏和信息串，进入代码恢复`, () => {
    const source = `前文\n\n${opening}\n  code  \n${closing}\n\n尾部`
    let state = EditorState.create({ doc: source, extensions: [markdown({ base: commonmarkLanguage }), EditorState.allowMultipleSelections.of(true), codeBlockControls({ slice: (state, from, to) => state.sliceDoc(from, to) })] })
    ensureSyntaxTree(state, state.doc.length, 100)
    state = state.update({ selection: { anchor: 0 } }).state
    expect(hiddenFences(state).map(range => [state.sliceDoc(range.from, range.to), range.block])).toEqual([[opening, false], [closing, true]])
    for (const anchor of [source.indexOf(opening), source.indexOf('code'), source.indexOf(closing, source.indexOf('code'))]) {
      expect(hiddenFences(state.update({ selection: { anchor } }).state)).toEqual([])
    }
    expect(hiddenFences(state.update({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(source.indexOf('code'))]) }).state)).toEqual([])
    expect(state.doc.toString()).toBe(source)
  })
}

it('未闭合围栏不隐藏，保留修复入口', () => {
  const source = '前文\n\n```json\n{"x":1}\n'
  const state = EditorState.create({ doc: source, extensions: [markdown({ base: commonmarkLanguage }), codeBlockControls({ slice: (state, from, to) => state.sliceDoc(from, to) })] })
  expect(hiddenFences(state)).toEqual([])
})

for (const [alias, expected] of [['py', 'Python'], ['python3', 'Python'], ['js', 'JavaScript'], ['ts', 'TypeScript'], ['golang', 'Go'], ['c++', 'C++'], ['c#', 'C#'], ['shell-session', 'Shell']]) {
  it(`围栏别名 ${alias} 识别为 ${expected}，不修改输入`, () => {
    const info = `${alias} filename="keep.ext"`
    expect(codeLanguage(info).label).toBe(expected)
    expect(info).toBe(`${alias} filename="keep.ext"`)
  })
}
it('未标语言和未知语言不猜测，未知名称保留', () => {
  expect(codeLanguage('').label).toBe('纯文本')
  expect(codeLanguage('text').description).toBeUndefined()
  expect(codeLanguage('my-pythonish').description).toBeUndefined()
  expect(codeLanguage('custom filename="keep"').label).toBe('custom')
})
it('懒加载失败明确报告且同一文件不反复请求，仍有纯文本解析器', async () => {
  const load = vi.fn(async () => { throw new Error('load failed') }), report = vi.fn()
  const language = LanguageDescription.of({ name: 'Broken', load })
  const resolver = createCodeLanguages(report, [language])
  expect(resolver('Broken')).toBe(resolver('broken'))
  const support = await resolver('broken')!.load()
  expect(support.language.parser).toBeTruthy()
  await resolver('Broken')!.load()
  expect(load).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledWith('Broken')
})
it('py 围栏嵌入实际 Python parser，关键词参与现有高亮主题', async () => {
  const resolver = createCodeLanguages(vi.fn())
  await resolver('py')!.load()
  const source = '~~~py filename="keep.py"\ndef greet():\n    return "hello"\n~~~'
  const state = EditorState.create({ doc: source, extensions: markdown({ base: commonmarkLanguage, codeLanguages: resolver }) })
  const tree = ensureSyntaxTree(state, source.length, 100)!
  const colored: string[] = []
  highlightTree(tree, codeHighlightStyle, (from, to) => colored.push(state.sliceDoc(from, to)))
  expect(colored).toContain('def'); expect(colored).toContain('return'); expect(colored).toContain('"hello"')
  expect(state.doc.toString()).toBe(source)
})

it('JSON 属性、字面量与括号分别着色，字符串内部括号不误着色', async () => {
  const resolver = createCodeLanguages(vi.fn())
  await resolver('json')!.load()
  const source = '```json\n{"name": "[John]", "items": [30, false, null]}\n```'
  const state = EditorState.create({ doc: source, extensions: markdown({ base: commonmarkLanguage, codeLanguages: resolver }) })
  const tree = ensureSyntaxTree(state, source.length, 100)!
  const tokens = new Map<string, string>()
  highlightTree(tree, codeHighlightStyle, (from, to, style) => tokens.set(state.sliceDoc(from, to), style))
  for (const text of ['{', '}', '[', ']', '"name"', '"[John]"', '30', 'false', 'null']) expect(tokens.has(text)).toBe(true)
  expect(tokens.get('{')).toBe(tokens.get('}'))
  expect(tokens.get('[')).toBe(tokens.get(']'))
  expect(new Set(['{', '[', '"name"', '"[John]"', '30', 'false'].map(text => tokens.get(text))).size).toBe(6)
  expect(tokens.get('false')).toBe(tokens.get('null'))
  expect(state.doc.toString()).toBe(source)
})

it('彩虹括号按深度循环，同型嵌套也变色，忽略字符串和注释并在围栏间重置', async () => {
  const resolver = createCodeLanguages(vi.fn())
  await resolver('js')!.load()
  const source = '```js\nconst x = (((((((1))))))); // (((\nconst s = "(((";\n(\n```\n\n```js\n(2)\n```'
  const state = EditorState.create({ doc: source, extensions: [markdown({ base: commonmarkLanguage, codeLanguages: resolver }), codeTheme] })
  ensureSyntaxTree(state, source.length, 100)
  const tokens: { text: string; color: string; from: number }[] = []
  rainbowBracketDecorations(state).between(0, source.length, (from, to, decoration) => { tokens.push({ text: state.sliceDoc(from, to), color: decoration.spec.class, from }) })
  expect(tokens.slice(0, 7).map(token => token.color)).toEqual([0, 1, 2, 3, 4, 5, 0].map(depth => `folio-rainbow-${depth}`))
  expect(tokens.slice(7, 14).map(token => token.color)).toEqual(tokens.slice(0, 7).map(token => token.color).reverse())
  expect(tokens).toHaveLength(17)
  expect(tokens.slice(-2).map(token => token.color)).toEqual(['folio-rainbow-0', 'folio-rainbow-0'])
  const changed = state.update({ changes: { from: source.indexOf('1'), insert: '(2)' } }).state
  const updated: string[] = []
  rainbowBracketDecorations(changed).between(0, changed.doc.length, (_from, _to, decoration) => { updated.push(decoration.spec.class) })
  expect(updated).toHaveLength(19)
  expect(updated.slice(7, 9)).toEqual(['folio-rainbow-1', 'folio-rainbow-1'])
  expect(state.doc.toString()).toBe(source)
})

for (const [source, expected] of [
  ['```js\na  \nb\n```\n', 'a  \nb\n'],
  ['\ufeff~~~~py filename="keep.py"\r\n  a\r\nb\n~~~~\r\n', '  a\r\nb\n'],
  ['> ```js\n> const a = 1\n> \n> x\n> ```\n', 'const a = 1\n\nx\n'],
  ['- ~~~go\r\n  a\r\n  b\r\n  ~~~', 'a\r\nb\r\n'],
  ['~~~\n\n~~~', '\n'],
  ['~~~go\na\n', 'a\n'],
] as const) it(`复制代码正文不带围栏／容器，保留原始空白 ${JSON.stringify(source)}`, () => {
  const format = preserveLineEndings(source)
  const state = EditorState.create({ doc: format.doc, extensions: [format.extension, markdown({ base: commonmarkLanguage }), codeBlockControls({ slice: format.slice })] })
  let block: SyntaxNode | undefined
  syntaxTree(state).iterate({ enter(node) { if (node.name === 'FencedCode') { block = node.node; return false } } })
  expect(fencedCodeText(state, block!, format.slice)).toBe(expected)
  expect(format.serialize(state)).toBe(source)
})
