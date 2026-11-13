import { describe, expect, it } from 'vitest'
import type { Entry } from '../../services/api'
import { isDirectoryForbidden } from './DirectoryPicker'

const entry = (path: string, kind: Entry['kind'] = 'directory'): Entry => ({ path, name: path.split('/').at(-1)!, kind, size: 0 })

describe('移动目录选择禁区', () => {
  it('禁止源目录自身和任意层级后代', () => {
    const entries = [entry('资料/中文目录')]
    for (const path of ['资料/中文目录', '资料/中文目录/子目录', '资料/中文目录/子目录/深层']) {
      expect(isDirectoryForbidden(path, entries)).toBe(true)
    }
  })

  it('允许根目录、祖先、同级和相似前缀', () => {
    const entries = [entry('资料/中文目录')]
    for (const path of ['', '资料', '资料/其他目录', '资料/中文目录副本', '资料/中文目录副本/子目录']) {
      expect(isDirectoryForbidden(path, entries)).toBe(false)
    }
  })

  it('只用剩余源目录定义禁区，不根据文件名、同父级或重名推断', () => {
    const entries = [entry('资料/笔记.md', 'file'), entry('归档'), entry('草稿')]
    expect(isDirectoryForbidden('资料', entries)).toBe(false)
    expect(isDirectoryForbidden('资料/笔记.md', entries)).toBe(false)
    expect(isDirectoryForbidden('归档/子目录', entries)).toBe(true)
    expect(isDirectoryForbidden('草稿', entries)).toBe(true)
    expect(isDirectoryForbidden('归档', entries.slice(2))).toBe(false)
    expect(isDirectoryForbidden('归档', [])).toBe(false)
  })
})
