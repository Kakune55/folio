import { describe, expect, it } from 'vitest'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { history, undo, redo, isolateHistory } from '@codemirror/commands'
import { preserveLineEndings } from './line-endings'
import { markdown, commonmarkLanguage } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'

function editor(source: string) {
  const format = preserveLineEndings(source)
  let state = EditorState.create({ doc: format.doc, extensions: [format.extension, history()] })
  return {
    text: () => format.serialize(state),
    edit: (from: number, to: number, insert: string, isolated = true) => {
      state = state.update({ changes: { from, to, insert }, annotations: [Transaction.userEvent.of('input.type'), ...(isolated ? [isolateHistory.of('full')] : [])] }).state
    },
    undo: () => undo({ state, dispatch: (transaction) => { state = transaction.state } }),
    redo: () => redo({ state, dispatch: (transaction) => { state = transaction.state } }),
  }
}

describe('源码的原始换行', () => {
  it('BOM 作为原始编码元数据保留，不阻挡首行 Markdown 解析', () => {
    const source = '\ufeff# 标题\r\n\r\n正文。'
    const format = preserveLineEndings(source)
    const state = EditorState.create({ doc: format.doc, extensions: [format.extension, markdown({ base: commonmarkLanguage })] })
    expect(state.doc.toString().startsWith('# 标题')).toBe(true)
    expect(syntaxTree(state).topNode.firstChild?.name).toBe('ATXHeading1')
    expect(format.serialize(state)).toBe(source)
  })
  for (const separator of ['\n', '\r\n', '\r']) it(`保留 ${JSON.stringify(separator)}，新行沿用原格式`, () => {
    const view = editor(`\ufeff甲${separator}乙${separator}`)
    expect(view.text()).toBe(`\ufeff甲${separator}乙${separator}`)
    view.edit(1, 1, 'X\nY')
    expect(view.text()).toBe(`\ufeff甲X${separator}Y${separator}乙${separator}`)
    expect(view.undo()).toBe(true)
    expect(view.text()).toBe(`\ufeff甲${separator}乙${separator}`)
    expect(view.redo()).toBe(true)
    expect(view.text()).toBe(`\ufeff甲X${separator}Y${separator}乙${separator}`)
  })

  it('混合换行随多处插入移动，被删除的原格式可撤销与重做', () => {
    const view = editor('a\r\nb\nc\rd\r\n')
    view.edit(1, 1, 'X\nY')
    expect(view.text()).toBe('aX\r\nY\r\nb\nc\rd\r\n')
    view.edit(8, 9, '')
    expect(view.text()).toBe('aX\r\nY\r\nb\ncd\r\n')
    view.undo()
    expect(view.text()).toBe('aX\r\nY\r\nb\nc\rd\r\n')
    view.undo()
    expect(view.text()).toBe('a\r\nb\nc\rd\r\n')
    view.redo(); view.redo()
    expect(view.text()).toBe('aX\r\nY\r\nb\ncd\r\n')
  })

  it('跨行替换、整篇替换和分组撤销不会遗留旧标记', () => {
    const view = editor('a\nb\r\nc\rd')
    view.edit(1, 6, '\n新\n')
    expect(view.text()).toBe('a\n新\nd')
    view.undo()
    expect(view.text()).toBe('a\nb\r\nc\rd')
    view.edit(0, 1, 'A', false)
    view.edit(1, 1, 'B', false)
    expect(view.text()).toBe('AB\nb\r\nc\rd')
    view.undo()
    expect(view.text()).toBe('a\nb\r\nc\rd')
    view.redo()
    expect(view.text()).toBe('AB\nb\r\nc\rd')
    view.edit(0, 8, '重写\n正文\n')
    expect(view.text()).toBe('重写\n正文\n')
    view.undo()
    expect(view.text()).toBe('AB\nb\r\nc\rd')
  })

  for (const source of ['头\n尾', '\ufeff头\r\n尾', '头\r尾']) it(`纯文本粘贴保留原换行及新增的混合分隔 ${JSON.stringify(source)}`, () => {
    const format = preserveLineEndings(source)
    let state = EditorState.create({ doc: format.doc, selection: { anchor: source.startsWith('\ufeff') ? 0 : 1 }, extensions: [format.extension, history()] })
    const pasted = '[keep]: /important\r\n~~~js filename="demo.js"\nconst a = 1\r~~~'
    state = state.update(format.paste(state, pasted)).state
    expect(format.serialize(state)).toBe(source.slice(0, 1) + pasted + source.slice(1))
    expect(undo({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(format.serialize(state)).toBe(source)
    expect(redo({ state, dispatch: transaction => { state = transaction.state } })).toBe(true)
    expect(format.serialize(state)).toBe(source.slice(0, 1) + pasted + source.slice(1))
  })

  it('显示扩展重配不改原文，已有修改的撤销与原始分隔均保留', () => {
    const source = '\ufeff# 标题\r\n\r\n[keep]: /value\n\n~~~js filename="a.js"\rconst a = 1\r~~~'
    const format = preserveLineEndings(source), display = new Compartment()
    let state = EditorState.create({ doc: format.doc, extensions: [format.extension, history(), display.of([])] })
    const original = state.doc
    state = state.update({ effects: display.reconfigure(EditorState.tabSize.of(8)) }).state
    expect(state.doc).toBe(original)
    expect(format.serialize(state)).toBe(source)
    state = state.update({ changes: { from: 2, insert: '新' } }).state
    state = state.update({ effects: display.reconfigure([]) }).state
    undo({ state, dispatch: transaction => { state = transaction.state } })
    expect(format.serialize(state)).toBe(source)
  })
})
