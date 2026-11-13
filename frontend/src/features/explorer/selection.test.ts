import { describe, expect, it } from 'vitest'
import type { Entry } from '../../services/api'
import { entryRange, reconcileEntrySelection } from './selection'

const row = (path: string): Entry => ({ path, name: path.split('/').at(-1)!, kind: 'file', size: 0 })
describe('文件树可见范围选择', () => {
  const visible = ['a.md', '目录/b.md', 'c.md', 'd.md'].map(row)
  it('按可见顺序选择并支持反向范围', () => {
    expect(entryRange(visible, '目录/b.md', visible[3])).toEqual(visible.slice(1))
    expect(entryRange(visible, 'd.md', visible[1])).toEqual(visible.slice(1))
  })
  it('锚点不可见、目标不在当前页时只选目标', () => {
    expect(entryRange(visible, '隐藏文件.md', visible[2])).toEqual([visible[2]])
    expect(entryRange(visible, null, visible[2])).toEqual([visible[2]])
    const hidden = row('未加载.md')
    expect(entryRange(visible, 'a.md', hidden)).toEqual([hidden])
  })
  it('单项范围不扩展到隐藏路径或相似前缀', () => {
    expect(entryRange(visible, 'c.md', visible[2])).toEqual([visible[2]])
    expect(entryRange([], 'a.md', visible[0])).toEqual([visible[0]])
  })
})

describe('文件树刷新后的选择范围', () => {
  const folder: Entry = { ...row('目录'), kind: 'directory' }
  const selected = new Map([folder, row('目录/笔记.md'), row('其他.md')].map(entry => [entry.path, entry]))
  it('只保留仍存在的路径，删除的父目录同时移除后代', () => {
    expect([...reconcileEntrySelection(selected, '', [row('其他.md')]).keys()]).toEqual(['其他.md'])
    expect(reconcileEntrySelection(selected, '', [folder, row('其他.md')])).toBe(selected)
  })
  it('列表读取失败后清除受影响子项，不保留可重复操作的过期路径', () => {
    expect([...reconcileEntrySelection(selected, '目录', null).keys()]).toEqual(['目录', '其他.md'])
    expect(reconcileEntrySelection(selected, '', null).size).toBe(0)
  })
  it('路径变为另一种条目时不沿用旧选择及其后代', () => {
    expect([...reconcileEntrySelection(selected, '', [row('目录'), row('其他.md')]).keys()]).toEqual(['其他.md'])
  })
})
