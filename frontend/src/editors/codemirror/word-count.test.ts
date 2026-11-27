import { EditorState } from '@codemirror/state'
import { expect, it } from 'vitest'
import { countWords, createWordCounter } from './word-count'

it('按原文统计汉字、单词和数字，忽略标点与空白', () => {
  expect(countWords('# 你好𠮷 Café cafe\u0301 don’t 2026！🙂\n')).toBe(7)
  expect(countWords(' **！  \n')).toBe(0)
})

it('单独统计选区，区分无选区和只选中标点', () => {
  const count = createWordCounter()
  const initial = EditorState.create({ doc: '你好，World' })
  expect(count(initial)).toEqual({ total: 3, selected: null })
  expect(count(initial.update({ selection: { anchor: 3, head: 2 } }).state)).toEqual({ total: 3, selected: 0 })
  expect(count(initial.update({ changes: { from: 0, insert: '早上' }, selection: { anchor: 4, head: 0 } }).state)).toEqual({ total: 5, selected: 4 })
})
