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

describe('条件自动保存', () => {
  it('请求期间继续编辑不误标已保存，后续写入使用新版本', async () => {
    let resolve!: (value: { revision: string }) => void
    const calls: { source: string; revision: string }[] = []
    const sessions = new WorkspaceSessions([{ path: '甲.md', source: '原文', mode: 'source', revision: 'v1' }], (_path, source, revision) => {
      calls.push({ source, revision }); return new Promise((done) => { resolve = done })
    })
    sessions.update('甲.md', '第一轮修改')
    const pending = sessions.save('甲.md')
    sessions.update('甲.md', '请求期间继续输入')
    expect(sessions.save('甲.md')).toBe(pending)
    expect(calls).toEqual([{ source: '第一轮修改', revision: 'v1' }])
    resolve({ revision: 'v2' }); await pending
    expect(sessions.get('甲.md')).toMatchObject({ dirty: true, revision: 'v2', original: '第一轮修改' })
    const second = sessions.save('甲.md')
    expect(calls[1]).toEqual({ source: '请求期间继续输入', revision: 'v2' })
    resolve({ revision: 'v3' }); await second
    expect(sessions.get('甲.md')).toMatchObject({ dirty: false, state: 'saved' })
  })
  it('冲突保留草稿且停止盲重试', async () => {
    let calls = 0
    const sessions = new WorkspaceSessions([{ path: '甲.md', source: '原文', mode: 'source', revision: 'v1' }], async () => {
      calls++; throw Object.assign(new Error('远端已修改'), { code: 'revision_conflict' })
    })
    sessions.update('甲.md', '本地草稿')
    expect(await sessions.save('甲.md')).toBe(false)
    expect(await sessions.save('甲.md')).toBe(false)
    expect(calls).toBe(1)
    expect(sessions.get('甲.md')).toMatchObject({ dirty: true, source: '本地草稿', revision: 'v1', state: 'conflict' })
    expect(sessions.remove('甲.md')).toBe(false)
  })
})

it('异步图片回到原会话，上传中不关闭标签页', async () => {
  const sessions = new WorkspaceSessions([{ path: '笔记.md', source: '正文\n', mode: 'rich' }])
  sessions.beginUpload('笔记.md')
  expect(sessions.remove('笔记.md')).toBe(false)
  expect(await sessions.flush('笔记.md')).toBe(false)
  sessions.setMode('笔记.md', 'source')
  sessions.appendAttachment('笔记.md', '![图](./image.png)')
  sessions.endUpload('笔记.md')
  expect(sessions.get('笔记.md')).toMatchObject({ source: '正文\n\n![图](./image.png)\n', dirty: true, pendingUploads: 0, generation: 1 })
})
