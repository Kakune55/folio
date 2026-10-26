import { afterEach, expect, it, vi } from 'vitest'
import { api, ApiError } from '../services/api'
import { WorkspaceSessions } from './workspace'
import { RemoteNotices } from './remote-notices'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
function setup() {
  vi.useFakeTimers()
  const sessions = new WorkspaceSessions([{ path: '甲.txt', source: '原文\n', mode: 'source', revision: 'v1' }])
  const notices = new RemoteNotices(sessions), session = sessions.get('甲.txt')
  vi.spyOn(api, 'metadata').mockResolvedValue({ path: session.path, size: 6, viewer: 'text', mediaType: 'text/plain', mtime: '' })
  const revision = vi.spyOn(api, 'textRevision')
  const read = vi.spyOn(api, 'read')
  const remote = (content: string, version: string) => {
    revision.mockResolvedValue({ path: session.path, revision: version })
    read.mockResolvedValue({ path: session.path, content, revision: version, size: content.length, kind: 'text', encoding: 'utf-8', mtime: '' })
  }
  return { sessions, session, notices, remote, read }
}

it('立即呈现远程正文，连续更新保留初始基准并重新计时，重复探测不重置', async () => {
  const { session, notices, remote } = setup()
  remote('第一次\n', 'v2'); await notices.check(session, undefined, 'Agent')
  expect(session.source).toBe('第一次\n')
  const first = notices.list()[0]
  expect(first).toMatchObject({ before: '原文\n', source: 'Agent', inserted: 1, deleted: 1 })
  await vi.advanceTimersByTimeAsync(3000)
  await notices.check(session)
  expect(notices.list()[0].deadline).toBe(first.deadline)
  remote('第二次\n新增\n', 'v3'); await notices.check(session, undefined, '另一个应用')
  const entry = notices.list()[0]
  expect(notices.list()).toHaveLength(1)
  expect(entry.before).toBe('原文\n')
  expect(entry.deadline).toBe(Date.now() + 10_000)
  expect(session.source).toBe('第二次\n新增\n')
  expect(session.externalUpdate?.previousSource).toBe('原文\n')
  notices.wait(entry)
  remote('第三次\n', 'v4'); await notices.check(session)
  expect(notices.list()[0].deadline).toBeNull()
  const write = vi.spyOn(api, 'write')
  await notices.accept(notices.list()[0])
  expect(notices.list()).toHaveLength(0)
  expect(write).not.toHaveBeenCalled()
})

it('回滚以最新检测版本条件写入初始正文，并恢复干净显示', async () => {
  const { session, notices, remote } = setup()
  remote('远程\n', 'v2'); await notices.check(session)
  remote('连续修改\n', 'v3'); await notices.check(session)
  const write = vi.spyOn(api, 'write').mockResolvedValue({ revision: 'v1' })
  await notices.rollback(notices.list()[0])
  expect(write).toHaveBeenCalledWith('甲.txt', '原文\n', 'v3')
  expect(session).toMatchObject({ source: '原文\n', revision: 'v1', dirty: false, state: 'saved', locked: false })
  expect(notices.list()).toHaveLength(0)
  expect(session.externalUpdate).toBeUndefined()
})

it('回滚冲突不修改当前正文、不移除通知且停止倒计时', async () => {
  const { session, notices, remote } = setup()
  remote('远程\n', 'v2'); await notices.check(session)
  vi.spyOn(api, 'write').mockRejectedValue(new ApiError(412, 'revision_conflict', '磁盘又有新版本'))
  await notices.rollback(notices.list()[0])
  expect(session.source).toBe('远程\n')
  expect(session.locked).toBe(false)
  expect(notices.list()[0]).toMatchObject({ deadline: null, busy: false })
  expect(notices.list()[0].error).toContain('磁盘又有新版本')
})

it('读取下一轮时接受上一轮，不复活已经确认的旧回滚基准', async () => {
  const { session, notices, remote, read } = setup()
  remote('已确认版本\n', 'v2'); await notices.check(session)
  const first = notices.list()[0]
  remote('下一轮\n', 'v3')
  let finish!: (file: Awaited<ReturnType<typeof api.read>>) => void
  read.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = notices.check(session)
  await Promise.resolve()
  await notices.accept(first)
  finish({ path: session.path, content: '下一轮\n', revision: 'v3', size: 6, kind: 'text', encoding: 'utf-8', mtime: '' })
  await pending
  expect(notices.list()[0].before).toBe('已确认版本\n')
  const write = vi.spyOn(api, 'write').mockResolvedValue({ revision: 'v2' })
  await notices.rollback(notices.list()[0])
  expect(write).toHaveBeenCalledWith('甲.txt', '已确认版本\n', 'v3')
})

it('远程读取期间输入不被覆盖，回滚保留本地草稿并暂停保存', async () => {
  const { sessions, session, notices, remote, read } = setup()
  remote('远程\n', 'v2')
  let finish!: (file: Awaited<ReturnType<typeof api.read>>) => void
  read.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = notices.check(session)
  await Promise.resolve()
  sessions.update(session.path, '我的草稿')
  finish({ path: session.path, content: '远程\n', revision: 'v2', size: 6, kind: 'text', encoding: 'utf-8', mtime: '' })
  await pending
  expect(session).toMatchObject({ source: '我的草稿', state: 'conflict', revision: 'v1' })
  expect(notices.list()[0].deadline).toBeNull()
  expect(await notices.accept(notices.list()[0])).toBe('conflict')
  expect(notices.list()).toHaveLength(1)
  expect(session.external).toBe('changed')
  vi.spyOn(api, 'write').mockResolvedValue({ revision: 'v1' })
  await notices.rollback(notices.list()[0])
  expect(session).toMatchObject({ source: '我的草稿', original: '原文\n', dirty: true, state: 'error' })
})

it('通知标记不在八秒独立过期，提前接受立即清除且不修改正文或代数', async () => {
  const { sessions, session, notices, remote } = setup()
  remote('远程\n', 'v2'); await notices.check(session)
  expect(session.externalUpdate?.expiresAt).toBeNull()
  await vi.advanceTimersByTimeAsync(8500)
  expect(session.externalUpdate).toBeDefined()
  const generation = session.generation
  const changed = vi.fn(); sessions.subscribe(changed)
  expect(await notices.accept(notices.list()[0])).toBe('accepted')
  expect(session.externalUpdate).toBeUndefined()
  expect(session.source).toBe('远程\n')
  expect(session.generation).toBe(generation)
  expect(changed).toHaveBeenCalled()
})

it('等待后标记长期驻留，后续远程更新仍驻留，决策才清除', async () => {
  const { session, notices, remote } = setup()
  remote('远程\n', 'v2'); await notices.check(session)
  notices.wait(notices.list()[0])
  await vi.advanceTimersByTimeAsync(60_000)
  expect(session.externalUpdate).toBeDefined()
  remote('下一轮\n', 'v3'); await notices.check(session)
  expect(notices.list()[0].deadline).toBeNull()
  expect(session.externalUpdate?.expiresAt).toBeNull()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(session.externalUpdate).toBeDefined()
  await notices.accept(notices.list()[0])
  expect(session.externalUpdate).toBeUndefined()
})

it('十秒倒计时接受清除标记，本地编辑提前清除旧位置且保留冲突', async () => {
  const { sessions, session, notices, remote } = setup()
  remote('远程\n', 'v2'); await notices.check(session)
  const entry = notices.list()[0]
  await vi.advanceTimersByTimeAsync(entry.deadline! - Date.now())
  await notices.accept(entry)
  expect(session.externalUpdate).toBeUndefined()
  remote('另一次\n', 'v3'); await notices.check(session)
  sessions.update(session.path, '本地草稿')
  expect(session.externalUpdate).toBeUndefined()
  expect(await notices.accept(notices.list()[0])).toBe('conflict')
  expect(session.source).toBe('本地草稿')
  expect(notices.list()[0].deadline).toBeNull()
})
