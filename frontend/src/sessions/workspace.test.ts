import { describe, expect, it, vi } from 'vitest'
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

it('移动目录同步重映射会话，并阻止目标路径与进行中的保存互相覆盖', async () => {
  const calls: string[] = []
  const sessions = new WorkspaceSessions([{ path: '旧目录/笔记.md', source: '正文', mode: 'rich', revision: 'v1' }], async (path) => { calls.push(path); return { revision: 'v2' } })
  sessions.update('旧目录/笔记.md', '未保存的修改')
  const affected = sessions.lockTree('旧目录', '新目录')
  expect(sessions.beginUpload('旧目录/笔记.md')).toBe(false)
  expect(await sessions.save('旧目录/笔记.md')).toBe(false)
  expect(sessions.remove('旧目录/笔记.md')).toBe(false)
  expect(() => sessions.add({ path: '新目录/笔记.md', source: '不能抢占', mode: 'source' })).toThrow()
  expect(await sessions.flush('旧目录/笔记.md', true)).toBe(true)
  sessions.remap('旧目录', '新目录')
  sessions.unlock(affected, ['旧目录', '新目录'])
  expect(sessions.get('新目录/笔记.md')).toMatchObject({ source: '未保存的修改', revision: 'v2', dirty: false, locked: false })
  expect(sessions.has('旧目录/笔记.md')).toBe(false)
  sessions.update('新目录/笔记.md', '继续编辑')
  await sessions.flush('新目录/笔记.md')
  expect(calls).toEqual(['旧目录/笔记.md', '新目录/笔记.md'])
})

it('恢复稿总是暂停自动保存，基准不同进入冲突，并且脏正文每次更新都发出缓存通知', async () => {
  let writes = 0, changes = 0
  const sessions = new WorkspaceSessions([], async () => { writes++; return { revision: '新版本' } })
  sessions.watchBuffers(() => changes++)
  const restored = sessions.restoreDraft({ path: '恢复.md', source: '恢复原文', original: '基准原文', revision: 'v1', mode: 'source' }, false)
  expect(restored).toMatchObject({ dirty: true, state: 'error', source: '恢复原文', revision: 'v1' })
  const before = changes
  sessions.update('恢复.md', '第一笔'); sessions.update('恢复.md', '第二笔')
  expect(changes - before).toBe(2)
  expect(writes).toBe(0)
  expect(() => sessions.restoreDraft({ path: '恢复.md', source: '不得覆盖', original: '', mode: 'source' }, true)).toThrow()
  const conflict = sessions.restoreDraft({ path: '冲突.md', source: '旧稿', original: '', revision: 'v0', mode: 'source' }, true)
  expect(conflict.state).toBe('conflict')
  expect(await sessions.save('冲突.md')).toBe(false)
  expect(writes).toBe(0)
  expect(await sessions.save('恢复.md')).toBe(true)
  expect(writes).toBe(1)
})

it('异步图片追加沿用原始换行，不改写已有正文', () => {
  for (const ending of ['\r\n', '\r', '\n']) {
    const source = `正文${ending}${ending}`
    const sessions = new WorkspaceSessions([{ path: '图.md', source, mode: 'source' }])
    sessions.appendAttachment('图.md', '![图](./image.png)')
    expect(sessions.get('图.md').source).toBe(`${source}![图](./image.png)${ending}`)
  }
})

it('输入法候选保留本地但不保存，确认后才提交最终原文', async () => {
  vi.useFakeTimers()
  try {
    const save = vi.fn(async () => ({ revision: 'v2' }))
    const sessions = new WorkspaceSessions([{ path: '输入.md', source: '原文', mode: 'rich', revision: 'v1' }], save)
    sessions.setComposing('输入.md', true)
    sessions.update('输入.md', '原文zhong')
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).not.toHaveBeenCalled()
    expect(await sessions.save('输入.md')).toBe(false)
    expect(sessions.get('输入.md')).toMatchObject({ source: '原文zhong', dirty: true, composing: true })
    expect(() => sessions.lockTree('输入.md')).toThrow()
    expect(() => sessions.acceptRemote('输入.md', '远端', 'remote')).toThrow()
    expect(sessions.remove('输入.md')).toBe(false)
    sessions.update('输入.md', '原文中文')
    sessions.setComposing('输入.md', false)
    await vi.advanceTimersByTimeAsync(801)
    expect(save).toHaveBeenCalledWith('输入.md', '原文中文', 'v1')
    expect(save).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})

it('输入法确认中断不自动写候选，仍可明确手动保存或下载', async () => {
  vi.useFakeTimers()
  try {
    const save = vi.fn(async () => ({ revision: 'v2' }))
    const sessions = new WorkspaceSessions([{ path: '输入.md', source: '原文', mode: 'rich', revision: 'v1' }], save)
    sessions.setComposing('输入.md', true); sessions.update('输入.md', '候选')
    sessions.setComposing('输入.md', false, true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).not.toHaveBeenCalled()
    expect(sessions.get('输入.md')).toMatchObject({ source: '候选', dirty: true, state: 'error', composing: false })
    expect(await sessions.save('输入.md')).toBe(false)
    sessions.confirmComposition('输入.md')
    expect(await sessions.save('输入.md')).toBe(true)
    expect(save).toHaveBeenCalledWith('输入.md', '候选', 'v1')
  } finally { vi.useRealTimers() }
})

it('旧保存响应不能清除其后发生的输入法中断保护', async () => {
  vi.useFakeTimers()
  try {
    let finish!: (result: { revision: string }) => void
    const calls: { source: string; revision: string }[] = []
    const sessions = new WorkspaceSessions([{ path: '输入.md', source: 'old', mode: 'rich', revision: 'v1' }], async (_path, source, revision) => {
      calls.push({ source, revision })
      return calls.length === 1 ? await new Promise(resolve => { finish = resolve }) : { revision: 'v3' }
    })
    sessions.update('输入.md', 'committed')
    const pending = sessions.save('输入.md')
    sessions.setComposing('输入.md', true); sessions.update('输入.md', 'committedzhong')
    sessions.setComposing('输入.md', false, true)
    finish({ revision: 'v2' }); await pending
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toEqual([{ source: 'committed', revision: 'v1' }])
    expect(sessions.get('输入.md')).toMatchObject({ original: 'committed', source: 'committedzhong', revision: 'v2', state: 'error', compositionInterrupted: true })
    sessions.confirmComposition('输入.md')
    expect(await sessions.save('输入.md')).toBe(true)
    expect(calls[1]).toEqual({ source: 'committedzhong', revision: 'v2' })
  } finally { vi.useRealTimers() }
})

it('上传完成时原笔记候选尚未确认，不追加引用或改变代数', async () => {
  vi.useFakeTimers()
  try {
    const save = vi.fn(async () => ({ revision: 'v2' }))
    const sessions = new WorkspaceSessions([{ path: '输入.md', source: 'old', mode: 'rich', revision: 'v1' }], save)
    sessions.setComposing('输入.md', true); sessions.update('输入.md', 'oldzhong')
    expect(sessions.appendAttachment('输入.md', '![图](./image.png)')).toBe(false)
    expect(sessions.get('输入.md')).toMatchObject({ source: 'oldzhong', generation: 0, composing: true })
    sessions.setComposing('输入.md', false, true)
    expect(sessions.appendAttachment('输入.md', '![图](./image.png)')).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
