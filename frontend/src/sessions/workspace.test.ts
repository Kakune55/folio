import { describe, expect, it } from 'vitest'
import { WorkspaceSessions } from './workspace'
describe('编辑会话正文隔离', () => {
  it('切换文件与模式保留各自的修改，恢复原文后清除脏标记', () => {
    const sessions = new WorkspaceSessions([{ path: '甲.md', source: '# 甲\n', mode: 'rich' }, { path: '乙.json', source: '{}', mode: 'source' }])
    sessions.update('甲.md', '# 甲\n\n最后一次输入')
    sessions.update('乙.json', '{"独立":true}')
    sessions.setMode('甲.md', 'source')
    expect(sessions.get('甲.md')).toMatchObject({ source: '# 甲\n\n最后一次输入', dirty: true, mode: 'source' })
    expect(sessions.get('乙.json').source).toBe('{"独立":true}')
    sessions.update('甲.md', '# 甲\n')
    expect(sessions.get('甲.md').dirty).toBe(false)
    expect(sessions.get('乙.json').dirty).toBe(true)
  })
})
