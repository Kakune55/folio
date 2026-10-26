import { describe, it, expect } from 'vitest'
import { externalMarks } from './external-marks'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undoDepth } from '@codemirror/commands'
import { clearSourceChangeMarks, sourceChangeMarks } from '../editors/changes/source'
describe('外部变更标记', () => {
  it('替换黄色，额外插入绿色', () => {
    expect(externalMarks('a\nb\nc\n', 'a\nB\nnew\nc\n').marks).toEqual([{ line: 2, kind: 'modified' }, { line: 3, kind: 'inserted' }])
  })
  it('删除缺口、文件头和 EOF 的红三角', () => {
    expect(externalMarks('a\nb\nc\n', 'a\nc\n').marks).toEqual([{ line: 2, kind: 'deleted', edge: 'before', count: 1 }])
    expect(externalMarks('a\nb\n', 'b\n').marks).toEqual([{ line: 1, kind: 'deleted', edge: 'before', count: 1 }])
    expect(externalMarks('a\nb\n', 'a\n').marks).toEqual([{ line: 1, kind: 'deleted', edge: 'after', count: 1 }])
    expect(externalMarks('a\n', '').marks).toEqual([{ line: 1, kind: 'deleted', edge: 'before', count: 1 }])
  })
  it('相同正文无标记，大文档有界退让并明示', () => {
    expect(externalMarks('a\n', 'a\n').marks).toEqual([])
    expect(externalMarks('x'.repeat(1_000_001), 'new')).toEqual({ marks: [], limited: true })
  })
  it('源码清理效果只移除装饰，不修改正文、选区和撤销历史', () => {
    const update = { id: 'notice', previousSource: '旧文\n', ...externalMarks('旧文\n', '新文\n'), expiresAt: null }
    let state = EditorState.create({ doc: '新文\n', selection: { anchor: 1 }, extensions: [history(), sourceChangeMarks(update)] })
    const count = (value: EditorState) => value.facet(EditorView.decorations).reduce((total, set) => total + (typeof set === 'function' ? 0 : set.size), 0)
    expect(count(state)).toBe(1)
    const transaction = state.update({ effects: clearSourceChangeMarks.of() })
    expect(transaction.docChanged).toBe(false)
    const previous = state
    state = transaction.state
    expect(count(state)).toBe(0)
    expect(state.doc).toBe(previous.doc)
    expect(state.selection.eq(previous.selection)).toBe(true)
    expect(undoDepth(state)).toBe(undoDepth(previous))
  })
})
