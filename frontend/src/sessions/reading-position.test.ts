import { expect, it } from 'vitest'
import { readPosition, readingPositionKey, writePosition } from './reading-position'
import { WorkspaceSessions } from './workspace'

it('续写位置按账号、工作区、路径和版本匹配，不写入未保存草稿的位置', () => {
  const data = new Map<string, string>()
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) } } satisfies Pick<Storage, 'getItem' | 'setItem'>
  const sessions = new WorkspaceSessions()
  const session = sessions.add({ path: '笔记.md', source: '正文', mode: 'rich', revision: 'v1' })
  const key = readingPositionKey('space', 1)
  const position = { anchor: 1, head: 2, scrollTop: 30, scrollLeft: 0, mode: 'rich' } as const
  writePosition(storage, key, session, position)
  expect(readPosition(storage, key, session)).toMatchObject(position)
  expect(readPosition(storage, key, { ...session, path: '另一篇.md' })).toBeUndefined()
  expect(readPosition(storage, key, { ...session, revision: 'v2' })).toBeUndefined()
  expect(readPosition(storage, readingPositionKey('space', 2), session)).toBeUndefined()
  expect(readPosition(storage, readingPositionKey('another', 1), session)).toBeUndefined()
  const draft = { ...session, dirty: true }
  writePosition(storage, key, draft, { ...position, head: 0 })
  expect(readPosition(storage, key, draft)).toBeUndefined()
  expect(readPosition(storage, key, session)).toMatchObject(position)
})
