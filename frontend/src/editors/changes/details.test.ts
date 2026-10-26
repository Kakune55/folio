import { expect, it } from 'vitest'
import { changeDetails } from './details'

it('替换段关联原文行号和当前行号，删除保留原内容及其缺口', () => {
  expect(changeDetails('head\nold\nkeep\ndelete\nend\n', 'head\nnew\nkeep\nend\n')).toEqual([
    { from: 2, to: 2, oldFrom: 2, oldTo: 2, before: 'old\n', after: 'new\n' },
    { from: 4, to: 4, oldFrom: 4, oldTo: 4, before: 'delete\n', after: '' },
  ])
})

it('处理纯新增、末尾删除、空文件和多行替换', () => {
  expect(changeDetails('', 'new\n')[0]).toMatchObject({ from: 1, to: 1, before: '', after: 'new\n' })
  expect(changeDetails('head\ndeleted', 'head\n')[0]).toMatchObject({ from: 2, before: 'deleted', after: '' })
  expect(changeDetails('a\nb\n', 'x\n')[0]).toEqual({ from: 1, to: 1, oldFrom: 1, oldTo: 2, before: 'a\nb\n', after: 'x\n' })
  expect(changeDetails('same\n', 'same\n')).toEqual([])
})

it('遵守输入预算，不为超限文本建立展开详情', () => {
  expect(changeDetails('a'.repeat(1_000_001), '')).toEqual([])
  expect(changeDetails('a\n'.repeat(20001), 'b\n')).toEqual([])
})
