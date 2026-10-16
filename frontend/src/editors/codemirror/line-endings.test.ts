import { describe, expect, it } from 'vitest'
import { EditorState, Transaction } from '@codemirror/state'
import { history, undo, redo, isolateHistory } from '@codemirror/commands'
import { preserveLineEndings } from './line-endings'

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
  for (const separator of ['\n', '\r\n', '\r']) it(`保留 ${JSON.stringify(separator)}，新行沿用原格式`, () => {
    const view = editor(`\ufeff甲${separator}乙${separator}`)
    expect(view.text()).toBe(`\ufeff甲${separator}乙${separator}`)
    view.edit(2, 2, 'X\nY')
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
})
