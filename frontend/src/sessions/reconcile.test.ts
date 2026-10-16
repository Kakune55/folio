import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceSessions } from './workspace'
import { api } from '../services/api'
import { reconcileSession, reloadCleanSession } from './reconcile'

afterEach(() => vi.restoreAllMocks())
const setup = () => new WorkspaceSessions([{ path: '甲.md', source: '原文', mode: 'rich', revision: 'v1' }], vi.fn(async () => ({ revision: 'v2' })))

it('检查期间开始自己的保存，晚到的探测结果不能制造冲突', async () => {
  const sessions = setup(), session = sessions.get('甲.md')
  let complete!: (value: { path: string; revision: string }) => void
  vi.spyOn(api, 'textRevision').mockImplementation(() => new Promise((resolve) => { complete = resolve }))
  const pending = reconcileSession(sessions, session)
  sessions.update('甲.md', '自己的修改'); await sessions.flush('甲.md')
  complete({ path: '甲.md', revision: 'v1' }); await pending
  expect(session).toMatchObject({ revision: 'v2', state: 'saved', source: '自己的修改' })
  expect(session.external).toBeUndefined()
})

it('外部变化与后续本地输入进入冲突，不推进保存版本', async () => {
  const sessions = setup(), session = sessions.get('甲.md')
  vi.spyOn(api, 'textRevision').mockResolvedValue({ path: '甲.md', revision: '外部版本' })
  await reconcileSession(sessions, session)
  expect(session).toMatchObject({ source: '原文', dirty: false, external: 'changed', revision: 'v1' })
  sessions.update('甲.md', '本地草稿')
  expect(await sessions.save('甲.md')).toBe(false)
  expect(session).toMatchObject({ source: '本地草稿', dirty: true, state: 'conflict', revision: 'v1' })
})

it('重新加载期间继续编辑，保留本地输入而不是应用晚到正文', async () => {
  const sessions = setup(), session = sessions.get('甲.md')
  vi.spyOn(api, 'metadata').mockResolvedValue({ path: '甲.md', size: 6, viewer: 'markdown', mediaType: 'text/markdown', mtime: '' })
  let complete!: (value: Awaited<ReturnType<typeof api.read>>) => void
  vi.spyOn(api, 'read').mockImplementation(() => new Promise((resolve) => { complete = resolve }))
  const pending = reloadCleanSession(sessions, session)
  await Promise.resolve()
  sessions.update('甲.md', '读取期间的新草稿')
  complete({ path: '甲.md', content: '磁盘正文', revision: '磁盘版本', size: 12, kind: 'text', encoding: 'utf-8', mtime: '' })
  await expect(pending).rejects.toThrow('本地又有变化')
  expect(session.source).toBe('读取期间的新草稿')
  await sessions.flush('甲.md')
})
