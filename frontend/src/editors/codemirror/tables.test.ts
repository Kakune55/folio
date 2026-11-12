import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { history, redo, undo } from '@codemirror/commands'
import { markdown, commonmarkLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { GFM } from '@lezer/markdown'
import { describe, expect, it, vi } from 'vitest'
import { preserveLineEndings } from './line-endings'
import { insertTableTransaction, tableAlignments, tableCellTransaction, tableContext, tableNavigation, tableSourceRows, tableTransaction, type TableAction } from './tables'

vi.mock('@codemirror/language', async importOriginal => {
  const actual = await importOriginal<typeof import('@codemirror/language')>()
  return { ...actual, ensureSyntaxTree: vi.fn(actual.ensureSyntaxTree) }
})

function editor(source: string, needle: string, readOnly = false) {
  const format = preserveLineEndings(source)
  let state = EditorState.create({ doc: format.doc, selection: { anchor: format.doc.indexOf(needle) }, extensions: [format.extension, markdown({ base: commonmarkLanguage, extensions: GFM }), history(), EditorState.readOnly.of(readOnly)] })
  return {
    get state() { return state },
    text: () => format.serialize(state),
    apply(spec: TransactionSpec | { error: string } | { boundary: true } | undefined, userEvent = 'input.table') {
      expect(spec).toBeDefined()
      expect(spec).not.toHaveProperty('error')
      expect(spec).not.toHaveProperty('boundary')
      const transaction = state.update(spec as TransactionSpec)
      expect(transaction.annotation(Transaction.userEvent)).toBe(userEvent)
      state = transaction.state
    },
    select(needle: string, length = 0, reverse = false) {
      const from = state.doc.toString().indexOf(needle)
      state = state.update({ selection: { anchor: from + (reverse ? length : 0), head: from + (reverse ? 0 : length) } }).state
    },
    undo() { return undo({ state, dispatch: tr => { state = tr.state } }) },
    redo() { return redo({ state, dispatch: tr => { state = tr.state } }) },
  }
}
const source = 'before\n\n  | H  |Long| Z |\n  | :---- |---:| :-----: |\n  | a\\|b |`code`| [x](url) |\n  | d | e  |f|\n\nafter'

describe('单元格直接编辑纯事务', () => {
  for (const [text, offset, removed, insert] of [['abXYef', 2, 2, 'XY'], ['abcXYdef', 3, 0, 'XY'], ['abef', 2, 2, '']] as const) it(`表头编辑 ${text} 仅提交公共前后缀之间的最小 diff`, () => {
    const original = '| abcdef | V |\n| --- | --- |\n| x | y |', view = editor(original, 'x')
    const cell = tableSourceRows(view.state, 0)![0][0]
    const spec = tableCellTransaction(view.state, cell.from, cell.to, text)
    expect(spec).not.toHaveProperty('error')
    const edits: unknown[] = []
    view.state.changes((spec as TransactionSpec).changes).iterChanges((from, to, _fromB, _toB, inserted) => edits.push([from, to, inserted.toString()]))
    expect(edits).toEqual([[cell.from + offset, cell.from + offset + removed, insert]])
    view.apply(spec, 'input.type')
    expect(view.text()).toBe(original.replace('abcdef', text))
    expect(tableSourceRows(view.state, 0)![0][0]).toEqual({ from: cell.from, to: cell.from + text.length, text })
  })

  it('只修改差异字符，保留 BOM、混合 EOL、其他单元格与 padding，并可撤销重做', () => {
    const original = '\ufeff前言\r\n\r\n  | H | V |\n  | --- | --- |\r  |  hello world   | a\\|b |\r\n\n尾部'
    const view = editor(original, '前言'), state = view.state
    const start = state.doc.toString().indexOf('  | H')
    const cell = tableSourceRows(state, start)![1][0]
    const spec = tableCellTransaction(state, cell.from, cell.to, 'hello WORLD')
    expect(spec).not.toHaveProperty('error')
    expect(view.state).toBe(state)
    expect(view.text()).toBe(original)
    const edits: unknown[] = []
    state.changes((spec as TransactionSpec).changes).iterChanges((from, to, _fromB, _toB, insert) => edits.push([from, to, insert.toString()]))
    expect(edits).toEqual([[cell.from + 6, cell.to, 'WORLD']])
    view.apply(spec, 'input.type')
    const expected = original.replace('hello world', 'hello WORLD')
    expect(view.text()).toBe(expected)
    expect(view.state.selection.main).toMatchObject({ from: cell.from, to: cell.from + 11 })
    expect(tableSourceRows(view.state, start)![1][0]).toEqual({ from: cell.from, to: cell.from + 11, text: 'hello WORLD' })
    expect(view.undo()).toBe(true); expect(view.text()).toBe(original); expect(view.state.selection).toEqual(state.selection)
    expect(view.redo()).toBe(true); expect(view.text()).toBe(expected)
  })

  it('填入和清空空格单元格时保留原 padding 与精确范围', () => {
    const original = '| H | V |\n| --- | --- |\n|    | z |'
    const view = editor(original, 'H')
    const cell = tableSourceRows(view.state, 0)![1][0]
    expect(cell.from).toBe(cell.to)
    view.apply(tableCellTransaction(view.state, cell.from, cell.to, 'a b'), 'input.type')
    expect(view.text()).toBe(original.replace('|    |', '| a b   |'))
    expect(tableSourceRows(view.state, 0)![1][0]).toEqual({ from: cell.from, to: cell.from + 3, text: 'a b' })
    view.apply(tableCellTransaction(view.state, cell.from, cell.from + 3, ''), 'input.type')
    expect(view.text()).toBe(original)
    expect(view.state.selection.main).toMatchObject({ from: cell.from, to: cell.from })
  })

  it('清空后允许 trim 范围漂移，保留原 padding 并从本地范围继续输入', () => {
    const original = '| H |\n| --- |\n|   value |'
    const view = editor(original, 'value'), cell = tableSourceRows(view.state, 0)![1][0]
    view.apply(tableCellTransaction(view.state, cell.from, cell.to, ''), 'input.type')
    expect(view.text()).toBe(original.replace('value', ''))
    expect(view.state.selection.main).toMatchObject({ from: cell.from, to: cell.from })
    expect(tableSourceRows(view.state, 0)![1][0].from).not.toBe(cell.from)
    view.apply(tableCellTransaction(view.state, cell.from, cell.from, 'next'), 'input.type')
    expect(view.text()).toBe(original.replace('value', 'next'))
  })

  it('接受同格内覆盖完整内容的范围，拒绝部分内容和跨格范围，不依赖当前选区', () => {
    const original = '| H | V |\n| --- | --- |\n| value | other |\n\n尾部'
    const view = editor(original, '尾部'), cell = tableSourceRows(view.state, 0)![1][0]
    for (const [from, to] of [[cell.from + 1, cell.to], [cell.from, cell.to - 1], [cell.from - 2, cell.to + 1], [cell.from, cell.from], [cell.from, cell.to + 5], [cell.to, cell.from], [-1, 0], [0, original.length + 1], [NaN, 1], [1.5, 2], [Infinity, Infinity], [original.indexOf('---'), original.indexOf('---') + 3], [original.indexOf('尾部'), original.length]]) {
      expect(tableCellTransaction(view.state, from, to, 'new')).toHaveProperty('error')
    }
    view.apply(tableCellTransaction(view.state, cell.from, cell.to, 'new'), 'input.type')
    expect(view.text()).toBe(original.replace('value', 'new'))
    expect(tableCellTransaction(view.state, cell.from, cell.to, 'stale')).toHaveProperty('error')
    const padded = editor(original, '尾部')
    padded.apply(tableCellTransaction(padded.state, cell.from - 1, cell.to + 1, ' new '), 'input.type')
    expect(padded.text()).toBe(original.replace('value', 'new'))
    expect(padded.state.selection.main).toMatchObject({ from: cell.from - 1, to: cell.from + 4 })
  })

  for (const text of [' leading', 'trailing ', ' ', '  both  ', '']) it(`支持首尾空格和清空 ${JSON.stringify(text)}，选区跟踪完整输入范围`, () => {
    const original = '| H |\n| --- |\n|  value   |', view = editor(original, 'value')
    const cell = tableSourceRows(view.state, 0)![1][0]
    view.apply(tableCellTransaction(view.state, cell.from, cell.to, text), 'input.type')
    expect(view.text()).toBe(original.replace('value', text))
    expect(view.state.selection.main).toMatchObject({ from: cell.from, to: cell.from + text.length })
    view.apply(tableCellTransaction(view.state, cell.from, cell.from + text.length, 'next'), 'input.type')
    expect(view.text()).toBe(original.replace('value', 'next'))
  })

  for (const initial of ['A', '   ']) it(`从 ${JSON.stringify(initial)} 逐键输入保留本地范围、padding 和撤销`, () => {
    const original = `| H | V |\n| --- | --- |\n|  ${initial}   | other |`, view = editor(original, 'H')
    const cell = tableSourceRows(view.state, 0)![1][0]
    const from = initial.trim() ? cell.from : original.lastIndexOf('|  ') + 3
    let to = from + initial.length
    for (const text of initial.trim() ? ['A ', 'A B'] : ['    ', '  B ']) {
      view.apply(tableCellTransaction(view.state, from, to, text), 'input.type')
      to = from + text.length
      expect(view.text()).toBe(original.slice(0, from) + text + original.slice(from + initial.length))
      expect(view.state.selection.main).toMatchObject({ from, to })
    }
    const expected = view.text()
    expect(view.undo()).toBe(true); expect(view.text()).toBe(original)
    expect(view.redo()).toBe(true); expect(view.text()).toBe(expected)
  })

  for (const text of ['a\nb', 'a\rb', 'a\r\nb', 'a\tb', 'a|b', 'a\\|b', '`a|b`']) it(`拒绝非法输入 ${JSON.stringify(text)} 并提供源码入口`, () => {
    const view = editor('| H |\n| --- |\n| value |', 'value'), state = view.state
    const cell = tableSourceRows(state, 0)![1][0]
    expect(tableCellTransaction(state, cell.from, cell.to, text)).toEqual({ error: expect.stringContaining('源码编辑') })
    expect(view.state).toBe(state)
    expect(view.text()).toBe('| H |\n| --- |\n| value |')
  })

  it('只读拒绝，连续输入使用 input.type 合并撤销且支持重做', () => {
    const original = '| H |\n| --- |\n| a |'
    const locked = editor(original, 'a', true), cell = tableSourceRows(locked.state, 0)![1][0]
    expect(tableCellTransaction(locked.state, cell.from, cell.to, 'ab')).toEqual({ error: expect.stringContaining('只读') })
    const view = editor(original, 'a'), selection = view.state.selection
    for (const text of ['ab', 'abc', 'abcd']) {
      const current = tableSourceRows(view.state, 0)![1][0]
      view.apply(tableCellTransaction(view.state, current.from, current.to, text), 'input.type')
    }
    expect(view.text()).toBe(original.replace('| a |', '| abcd |'))
    expect(view.undo()).toBe(true); expect(view.text()).toBe(original); expect(view.state.selection).toEqual(selection)
    expect(view.undo()).toBe(false)
    expect(view.redo()).toBe(true); expect(view.text()).toBe(original.replace('| a |', '| abcd |'))
  })

  for (const original of ['| A | B |\n| --- | --- |\n| ragged |', '> | A | B |\n> | --- | --- |\n> | x | y |', '- | A | B |\n  | --- | --- |\n  | x | y |', '```md\n| A | B |\n| --- | --- |\n| x | y |\n```', '| A | B |\n| --- | --- |\n| ' + 'x'.repeat(20001) + ' | y |', '| A | B |\n| --- | --- |\n' + '| x | y |\n'.repeat(251)]) it('拒绝 invalid、嵌套和超预算结构', () => {
    const view = editor(original, 'A'), from = original.indexOf('A')
    expect(tableCellTransaction(view.state, from, from + 1, 'new')).toHaveProperty('error')
    expect(view.text()).toBe(original)
  })

  it('单表字符预算允许 20000，拒绝增加至 20001', () => {
    const original = '| H |\n| --- |\n| x |', view = editor(original, 'x')
    const cell = tableSourceRows(view.state, 0)![1][0]
    expect(tableCellTransaction(view.state, cell.from, cell.to, 'x'.repeat(20002 - original.length))).toHaveProperty('error')
    view.apply(tableCellTransaction(view.state, cell.from, cell.to, 'x'.repeat(20001 - original.length)), 'input.type')
    expect(view.state.doc.length).toBe(20000)
  })

  it('末尾反斜线或空表头破坏结构时拒绝，未改变内容返回空 diff', () => {
    const original = 'H | V\n--- | ---\nx|y', view = editor(original, 'x')
    const cell = tableSourceRows(view.state, 0)![1][0]
    expect(tableCellTransaction(view.state, cell.from, cell.to, 'x\\')).toHaveProperty('error')
    const header = tableSourceRows(view.state, 0)![0][0]
    expect(tableCellTransaction(view.state, header.from, header.to, '')).toHaveProperty('error')
    const spec = tableCellTransaction(view.state, cell.from, cell.to, 'x')
    expect(view.state.changes((spec as TransactionSpec).changes).empty).toBe(true)
    view.apply(spec, 'input.type')
    expect(view.text()).toBe(original)
  })
})

describe('表格原文局部事务', () => {
  it('在混合换行的行后插入再删除新行，不把原行分隔符移给新行', () => {
    const source = '\ufeff前言\r\n\r\n| H | V |\n| --- | --- |\r\n| A | B |\n\n尾部'
    const view = editor(source, 'A')
    view.apply(tableTransaction(view.state, 'insertRowAfter'))
    expect(view.text()).toContain('| A | B |\n|  |  |\r\n')
    view.apply(tableTransaction(view.state, 'deleteRow'))
    expect(view.text()).toBe(source)
  })
  it('Markdown代码围栏里的示例表格不抢普通代码Tab', () => {
    const source = '```md\n| H | V |\n| --- | --- |\n| A | B |\n```'
    const nested = markdown({ base: commonmarkLanguage, extensions: GFM })
    const state = EditorState.create({ doc: source, selection: { anchor: source.indexOf('A') }, extensions: markdown({ base: commonmarkLanguage, extensions: GFM, codeLanguages: () => nested.language }) })
    expect(tableContext(state)).toBeUndefined()
    expect(tableNavigation(state, false)).toBeUndefined()
  })
  it('恰在处理预算行尾后仍有后续行时，不能只操作解析到的一部分', () => {
    const prefix = '| H |\n| --- |\n'
    const rows = `| ${'x'.repeat(45)} |\n`.repeat(399)
    const before = prefix + rows
    const boundary = `| ${'z'.repeat(20000 - before.length - 4)} |\n`
    const source = before + boundary + '| y |\n'
    expect((before + boundary).length).toBe(20001)
    const view = editor(source, 'H')
    expect(tableTransaction(view.state, 'insertColumnAfter')).toHaveProperty('error')
    expect(view.text()).toBe(source)
  })
  it('长文档末尾每次只读查询及表外 Tab 不强制解析', () => {
    const original = '# 标题\n\n' + '普通段落。\n\n'.repeat(10000) + '尾段'
    const view = editor(original, '尾段')
    vi.mocked(ensureSyntaxTree).mockClear()
    for (let i = 0; i < 10; i++) {
      expect(tableContext(view.state)).toBeUndefined()
      expect(tableNavigation(view.state, false)).toBeUndefined()
      expect(tableNavigation(view.state, true)).toBeUndefined()
      expect(tableAlignments(view.state, original.indexOf('尾段'))).toBeUndefined()
    }
    expect(ensureSyntaxTree).not.toHaveBeenCalled()
    expect(view.text()).toBe(original)
  })

  it('表内只读 context 和 alignments 也不补解析，显式操作才有界确认', () => {
    const view = editor(source, '`code`')
    vi.mocked(ensureSyntaxTree).mockClear()
    expect(tableContext(view.state)).toMatchObject({ column: 1 })
    expect(tableAlignments(view.state, source.indexOf('  | H'))).toEqual(['left', 'right', 'center'])
    expect(ensureSyntaxTree).not.toHaveBeenCalled()
    view.apply(tableTransaction(view.state, 'alignCenter'))
    expect(ensureSyntaxTree).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ensureSyntaxTree).mock.calls[0][1]).toBeLessThanOrEqual(source.indexOf('| H') + 20001)
  })

  it('核对已安装 Lezer 的节点实际范围，空格和空格单元格不产生额外内容节点', () => {
    const view = editor('| H |  |\n| --- | --- |\n| a\\|b | `x` |', 'H')
    const table = syntaxTree(view.state).topNode.firstChild!
    expect(table.name).toBe('Table')
    const header = table.getChild('TableHeader')!
    expect(header.getChildren('TableCell').map(c => [c.from, c.to])).toEqual([[2, 3]])
    expect(header.getChildren('TableDelimiter').map(c => [c.from, c.to])).toEqual([[0, 1], [4, 5], [7, 8]])
    const delimiter = table.getChild('TableDelimiter')!
    expect(view.state.sliceDoc(delimiter.from, delimiter.to)).toBe('| --- | --- |')
    expect(tableContext(view.state)).toMatchObject({ row: 0, column: 0, rowCount: 2, columnCount: 2, alignment: 'none', cell: { from: 2, to: 3 } })
  })

  for (const [needle, action, expected] of [
    ['a\\|b', 'deleteColumn', 'before\n\n  |Long| Z |\n  |---:| :-----: |\n  |`code`| [x](url) |\n  | e  |f|\n\nafter'],
    ['`code`', 'deleteColumn', 'before\n\n  | H  | Z |\n  | :---- | :-----: |\n  | a\\|b | [x](url) |\n  | d |f|\n\nafter'],
    ['[x]', 'deleteColumn', 'before\n\n  | H  |Long|\n  | :---- |---:|\n  | a\\|b |`code`|\n  | d | e  |\n\nafter'],
    ['a\\|b', 'deleteRow', 'before\n\n  | H  |Long| Z |\n  | :---- |---:| :-----: |\n  | d | e  |f|\n\nafter'],
    ['d |', 'deleteRow', 'before\n\n  | H  |Long| Z |\n  | :---- |---:| :-----: |\n  | a\\|b |`code`| [x](url) |\n\nafter'],
  ] as const) it(`${action} ${needle} 保留未修改字节且可撤销重做`, () => {
    const view = editor(source, needle), originalSelection = view.state.selection
    view.apply(tableTransaction(view.state, action))
    expect(view.text()).toBe(expected)
    expect(tableContext(view.state)).toBeDefined()
    expect(view.undo()).toBe(true); expect(view.text()).toBe(source); expect(view.state.selection).toEqual(originalSelection)
    expect(view.redo()).toBe(true); expect(view.text()).toBe(expected)
    expect(view.state.selection.main.to).toBeLessThanOrEqual(view.state.doc.length)
  })

  for (const [action, expected] of [
    ['alignLeft', ':---'], ['alignCenter', ':---:'], ['alignRight', '---:'],
  ] as const) it(`${action} 只改冒号并保持连字符长度与 padding`, () => {
    const view = editor(source, '`code`')
    view.apply(tableTransaction(view.state, action))
    expect(view.text()).toBe(source.replace('|---:|', `|${expected}|`))
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('`code`')
  })

  for (const [action, expected] of [
    ['insertColumnBefore', 'A  | 新列 | B\n:---- | --- | ----:\na\\|b |  | `code`'],
    ['insertColumnAfter', 'A  | B| 新列 |\n:---- | ----:| --- |\na\\|b | `code`|  |'],
    ['deleteColumn', 'A  |\n:---- |\na\\|b |'],
  ] as const) it(`无外管线 ${action}`, () => {
    const original = 'A  | B\n:---- | ----:\na\\|b | `code`'
    const view = editor(original, '`code`')
    view.apply(tableTransaction(view.state, action))
    expect(view.text()).toBe(expected)
    expect(tableContext(view.state)?.columnCount).toBe(action === 'deleteColumn' ? 1 : 3)
  })

  it('插入表头下方越过 delimiter，正文前插不修改既有行', () => {
    const view = editor(source, 'H  ')
    view.apply(tableTransaction(view.state, 'insertRowAfter'))
    expect(view.text()).toBe(source.replace('  | a\\|b', '  |  |  |  |\n  | a\\|b'))
    expect(tableContext(view.state)).toMatchObject({ row: 1, column: 0 })
    const other = editor(source, 'd |')
    other.apply(tableTransaction(other.state, 'insertRowBefore'))
    expect(other.text()).toBe(source.replace('  | d |', '  |  |  |  |\n  | d |'))
  })

  it('删除中间正文行将选区移到下一行', () => {
    const view = editor('| H |\n| --- |\n| first |\n| middle |\n| last |', 'middle')
    view.apply(tableTransaction(view.state, 'deleteRow'))
    expect(view.text()).toBe('| H |\n| --- |\n| first |\n| last |')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('last')
  })

  it('无外管线首列前插补管线，首列删除至单列保留原分隔符', () => {
    const original = 'A | B\n---- | :---:\nx | y'
    const view = editor(original, 'x |')
    view.apply(tableTransaction(view.state, 'insertColumnBefore'))
    expect(view.text()).toBe('| 新列 |A | B\n| --- |---- | :---:\n|  |x | y')
    expect(tableContext(view.state)).toMatchObject({ column: 0, columnCount: 3 })
    expect(view.undo()).toBe(true)
    view.apply(tableTransaction(view.state, 'deleteColumn'))
    expect(view.text()).toBe('| B\n| :---:|\n| y')
    expect(tableContext(view.state)).toMatchObject({ column: 0, columnCount: 1 })
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('y')
  })

  it('连续行列操作分别形成独立可撤销事务', () => {
    const view = editor(source, '`code`')
    view.apply(tableTransaction(view.state, 'alignCenter'))
    const aligned = view.text()
    view.apply(tableTransaction(view.state, 'insertColumnAfter'))
    const expanded = view.text()
    expect(view.undo()).toBe(true); expect(view.text()).toBe(aligned)
    expect(view.undo()).toBe(true); expect(view.text()).toBe(source)
    expect(view.redo()).toBe(true); expect(view.text()).toBe(aligned)
    expect(view.redo()).toBe(true); expect(view.text()).toBe(expanded)
  })

  it('转义管线、行内代码与链接原文在其他列变更时完全保留', () => {
    const original = '| A | B | C |\n| --- | :----: | ---: |\n| `a\\|b` | [x\\|y](url) | tail |'
    const view = editor(original, 'tail')
    view.apply(tableTransaction(view.state, 'insertColumnBefore'))
    expect(view.text()).toBe('| A | B | 新列 | C |\n| --- | :----: | --- | ---: |\n| `a\\|b` | [x\\|y](url) |  | tail |')
    expect(tableContext(view.state)).toMatchObject({ columnCount: 4, column: 2 })
  })

  it('末格反斜线会转义新增管线时拒绝，不猜测修复原文', () => {
    const original = 'A | B\n--- | ---\nx | end\\'
    const view = editor(original, 'end')
    expect(tableTransaction(view.state, 'insertColumnAfter')).toHaveProperty('error')
    expect(view.text()).toBe(original)
  })

  for (const [left, right] of [[false, false], [true, false], [false, true], [true, true]]) {
    for (const [needle, action] of [['x', 'deleteColumn'], ['y', 'deleteColumn'], ['x', 'insertColumnBefore'], ['y', 'insertColumnAfter']] as const) {
      it(`外管线 ${left}/${right} 的 ${action} ${needle} 保持有效表结构与邻格选区`, () => {
        const wrap = (text: string) => (left ? '|' : '') + text + (right ? '|' : '')
        const original = [wrap(' A | B '), wrap(' --- | :----: '), wrap(' x | y ')].join('\n')
        const view = editor(original, needle)
        view.apply(tableTransaction(view.state, action))
        expect(tableContext(view.state)).toMatchObject({ row: 1, columnCount: action === 'deleteColumn' ? 1 : 3 })
        if (action === 'deleteColumn') expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(needle === 'x' ? 'y' : 'x')
        expect(view.undo()).toBe(true); expect(view.text()).toBe(original)
        expect(view.redo()).toBe(true)
        expect(tableContext(view.state)).toBeDefined()
      })
    }
  }

  it('光标在表格开始、分隔行或空格单元格时仍可定位', () => {
    const original = '| A | B |\n| :--- | ---: |\n|  |  |'
    const view = editor(original, '| A')
    expect(tableContext(view.state)).toMatchObject({ row: 0, column: 0 })
    view.select('---:')
    expect(tableContext(view.state)).toMatchObject({ row: 0, column: 1, alignment: 'right' })
    view.select('|  |')
    view.apply(tableNavigation(view.state, false))
    expect(tableContext(view.state)).toMatchObject({ row: 1, column: 1 })
  })

  it('允许删除最后正文行成为 header-only，禁止删除表头和最后列', () => {
    const view = editor('| H |\n| --- |\n| body |', 'body')
    view.apply(tableTransaction(view.state, 'deleteRow'))
    expect(view.text()).toBe('| H |\n| --- |')
    expect(tableContext(view.state)).toMatchObject({ rowCount: 1, row: 0 })
    for (const action of ['deleteRow', 'deleteColumn', 'insertRowBefore'] as const) expect(tableTransaction(view.state, action)).toHaveProperty('error')
  })

  it('Tab 选择下格，Shift-Tab 前格，第一格交回工具栏', () => {
    const view = editor(source, 'H  ')
    expect(tableNavigation(view.state, true)).toEqual({ boundary: true })
    view.apply(tableNavigation(view.state, false))
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('Long')
    view.apply(tableNavigation(view.state, true))
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('H')
  })

  for (const tail of ['', '\n']) it(`最后一格 Tab 新增正文行，保留 EOF ${JSON.stringify(tail)}`, () => {
    const original = '| A | B |\n| --- | --- |\n| x | y |' + tail
    const view = editor(original, 'y |')
    view.apply(tableNavigation(view.state, false))
    expect(view.text()).toBe('| A | B |\n| --- | --- |\n| x | y |\n|  |  |' + tail)
    expect(tableContext(view.state)).toMatchObject({ row: 2, column: 0 })
    expect(view.state.selection.main.empty).toBe(true)
    expect(view.undo()).toBe(true); expect(view.text()).toBe(original)
    expect(view.redo()).toBe(true)
  })

  it('header-only Tab 创建第一正文行', () => {
    const view = editor('| A | B |\n| --- | --- |', 'B |')
    view.apply(tableNavigation(view.state, false))
    expect(view.text()).toBe('| A | B |\n| --- | --- |\n|  |  |')
    expect(tableContext(view.state)).toMatchObject({ row: 1, column: 0 })
  })

  it('新表选中默认第一列表头，保留外部内容，可撤销重做', () => {
    const view = editor('before\n\nafter', '\nafter')
    view.apply(insertTableTransaction(view.state, 1, 2))
    expect(view.text()).toBe('before\n\n| 列 1 | 列 2 |\n| --- | --- |\n|   |   |\n\nafter')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('列 1')
    expect(view.undo()).toBe(true); expect(view.text()).toBe('before\n\nafter')
    expect(view.redo()).toBe(true)
  })

  for (const reverse of [false, true]) it(`新表在 selection.to 插入，不覆盖选中文字，反向选区 ${reverse}`, () => {
    const original = '  before chosen  after\t '
    const view = editor(original, 'chosen')
    view.select('chosen', 'chosen'.length, reverse)
    const selection = view.state.selection
    view.apply(insertTableTransaction(view.state, 1, 2))
    expect(view.text()).toBe('  before chosen\n\n| 列 1 | 列 2 |\n| --- | --- |\n|   |   |\n\n  after\t ')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('列 1')
    expect(view.undo()).toBe(true); expect(view.text()).toBe(original); expect(view.state.selection).toEqual(selection)
    expect(view.redo()).toBe(true)
    expect(view.text().startsWith('  before chosen')).toBe(true)
    expect(view.text().endsWith('  after\t ')).toBe(true)
  })

  it('已有前后空行不新增、不 trim 空白原文', () => {
    const original = 'before  \n\n\n\n\t after '
    const view = editor(original, '\n\n\t')
    view.apply(insertTableTransaction(view.state, 1, 1))
    expect(view.text()).toBe('before  \n\n| 列 1 |\n| --- |\n|   |\n\n\t after ')
  })

  for (const [original, position, prefix, suffix] of [
    ['paragraph', 0, '', '\n\n'],
    ['  left RIGHT\t ', 7, '\n\n', '\n\n'],
    ['paragraph', 9, '\n\n', ''],
    ['paragraph\n', 9, '\n\n', '\n'],
    ['paragraph\n', 10, '\n', ''],
    ['paragraph\n\n', 11, '', ''],
    ['# Heading', 9, '\n\n', ''],
    ['## Head tail', 7, '\n\n', '\n\n'],
    ['before\n\nafter', 8, '', '\n\n'],
    ['before\n\nafter', 7, '\n', '\n'],
  ] as const) it(`普通顶层插表位置 ${position} 保留所有原字节 ${JSON.stringify(original)}`, () => {
    const view = editor(original, '')
    const state = view.state.update({ selection: { anchor: position } }).state
    const spec = insertTableTransaction(state, 1, 1)
    expect(spec).not.toHaveProperty('error')
    const table = '| 列 1 |\n| --- |\n|   |'
    view.apply(spec)
    const expected = original.slice(0, position) + prefix + table + suffix + original.slice(position)
    expect(view.text()).toBe(expected)
    expect(view.text().slice(0, position)).toBe(original.slice(0, position))
    expect(view.text().slice(position + prefix.length + table.length + suffix.length)).toBe(original.slice(position))
    expect(tableContext(view.state)).toMatchObject({ rowCount: 2, columnCount: 1 })
    expect(view.undo()).toBe(true); expect(view.text()).toBe(original)
    expect(view.redo()).toBe(true); expect(view.text()).toBe(expected)
  })

  it('只读对齐读取独立于当前选区，支持原表格起点或缩进后节点起点', () => {
    const view = editor(source, 'before', true)
    expect(tableAlignments(view.state, source.indexOf('  | H'))).toEqual(['left', 'right', 'center'])
    expect(tableAlignments(view.state, source.indexOf('| H'))).toEqual(['left', 'right', 'center'])
    expect(tableContext(view.state)).toBeUndefined()
    expect(view.text()).toBe(source)
    for (const from of [-1, source.length + 1, NaN, 1.5, 0]) expect(tableAlignments(view.state, from)).toBeUndefined()
    expect(tableAlignments(editor('| A | B |\n| --- | --- |\n| ragged |', 'A').state, 0)).toBeUndefined()
  })

  it('新增列表头为新列且选中，已有表头原字节不变', () => {
    const view = editor(source, 'Long')
    view.apply(tableTransaction(view.state, 'insertColumnAfter'))
    expect(view.text()).toBe(source.replace('|Long|', '|Long| 新列 |').replace('|---:|', '|---:| --- |').replace('|`code`|', '|`code`|  |').replace('| e  |', '| e  |  |'))
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('新列')
  })

  it('跨单元格选区不能通过新表插入绕过保护', () => {
    const view = editor(source, 'a\\|b')
    view.select('a\\|b', 'a\\|b |`code`'.length)
    expect(insertTableTransaction(view.state, 1, 2)).toHaveProperty('error')
    expect(view.text()).toBe(source)
  })

  for (const separator of ['\r\n', '\r']) it(`选区追加新表保留 BOM 与原始 ${JSON.stringify(separator)}，可撤销`, () => {
    const original = '\ufeffbefore  ' + separator + 'chosen\t after ' + separator
    const view = editor(original, 'chosen')
    view.select('chosen', 6)
    view.apply(insertTableTransaction(view.state, 1, 1))
    expect(view.text()).toBe('\ufeffbefore  ' + separator + ['chosen', '', '| 列 1 |', '| --- |', '|   |', '', '\t after '].join(separator) + separator)
    expect(view.undo()).toBe(true); expect(view.text()).toBe(original)
    expect(view.redo()).toBe(true)
  })

  for (const [rows, cols] of [[1, 1], [20, 20]]) it(`新表合法边界 ${rows}/${cols}`, () => {
    const view = editor('', '')
    view.apply(insertTableTransaction(view.state, rows, cols))
    expect(tableContext(view.state)).toMatchObject({ rowCount: rows + 1, columnCount: cols })
  })
  it('不在围栏代码内部的空行插入伪表格', () => {
    const view = editor('```md\n\n```', '\n```')
    expect(insertTableTransaction(view.state, 1, 2)).toHaveProperty('error')
    expect(view.text()).toBe('```md\n\n```')
  })
  for (const [rows, cols] of [[0, 1], [21, 1], [1, 0], [1, 21], [1.5, 2], [NaN, 2]]) it(`拒绝非法尺寸 ${rows}/${cols}`, () => {
    expect(insertTableTransaction(editor('', '').state, rows, cols)).toHaveProperty('error')
  })

  it('纯函数不改变 state，表外导航不处理，readOnly 所有操作拒绝', () => {
    const view = editor(source, '`code`'), original = view.state
    tableTransaction(view.state, 'insertColumnBefore')
    expect(view.state).toBe(original); expect(view.text()).toBe(source)
    const readonly = editor(source, '`code`', true)
    const actions: TableAction[] = ['insertRowBefore', 'insertRowAfter', 'deleteRow', 'insertColumnBefore', 'insertColumnAfter', 'deleteColumn', 'alignLeft', 'alignCenter', 'alignRight']
    for (const action of actions) expect(tableTransaction(readonly.state, action)).toHaveProperty('error')
    expect(tableNavigation(readonly.state, false)).toHaveProperty('error')
    expect(insertTableTransaction(readonly.state, 1, 1)).toHaveProperty('error')
    view.select('before')
    expect(tableNavigation(view.state, false)).toBeUndefined()
    expect(tableContext(view.state)).toBeUndefined()
    expect(tableTransaction(view.state, 'deleteRow')).toHaveProperty('error')
    expect(insertTableTransaction(view.state, 1, 1)).not.toHaveProperty('error')
  })

  for (const original of ['| A | B |\n| --- | --- |\n| ragged |', '> | A | B |\n> | --- | --- |\n> | x | y |', '| A | B |\n| --- | --- |\n| ' + 'x'.repeat(20001) + ' | y |', '| A | B |\n| --- | --- |\n' + '| x | y |\n'.repeat(251)]) it('不可验证或超预算表明确拒绝而非重排', () => {
    const view = editor(original, 'A |')
    expect(tableContext(view.state)).toBeUndefined()
    expect(tableTransaction(view.state, 'alignLeft')).toHaveProperty('error')
    expect(tableNavigation(view.state, false)).toHaveProperty('error')
    expect(view.text()).toBe(original)
  })

  it('跨单元格／跨行选择拒绝，不完整 Markdown 不拦截普通输入', () => {
    const view = editor(source, '`code`')
    const state = view.state.update({ selection: { anchor: source.indexOf('a\\|b'), head: source.indexOf('f|') } }).state
    expect(tableTransaction(state, 'deleteRow')).toHaveProperty('error')
    expect(tableNavigation(editor('| typing', 'typing').state, false)).toBeUndefined()
  })

  for (const separator of ['\n', '\r\n', '\r']) for (const tail of ['', separator]) it(`BOM 与 ${JSON.stringify(separator)} EOF ${!!tail} 串联保源和历史`, () => {
    const original = '\ufeff' + ['| A | B |', '| :----- | ---: |', '| x | y |'].join(separator) + tail
    const view = editor(original, 'y |')
    view.apply(tableNavigation(view.state, false))
    expect(view.text()).toBe('\ufeff' + ['| A | B |', '| :----- | ---: |', '| x | y |', '|  |  |'].join(separator) + tail)
    const changed = view.text()
    expect(view.undo()).toBe(true); expect(view.text()).toBe(original)
    expect(view.redo()).toBe(true); expect(view.text()).toBe(changed)
  })
})
