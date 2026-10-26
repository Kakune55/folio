import { api, ApiError } from '../services/api'
import type { Session, WorkspaceSessions } from './workspace'

const editable = (session: Session) => ['markdown', 'text'].includes(session.viewer)
const checkpoint = (session: Session) => ({ session, path: session.path, revision: session.revision, generation: session.generation })
type Checkpoint = ReturnType<typeof checkpoint>
function current(sessions: WorkspaceSessions, check: Checkpoint) {
  return sessions.has(check.path) && sessions.get(check.path) === check.session && check.session.revision === check.revision && check.session.generation === check.generation && !check.session.locked && !check.session.pendingUploads && check.session.state !== 'saving'
}

// 探测结果只能作用于同一个版本的会话；晚到响应不能把自己的保存误判为外部修改。
export async function reconcileSession(sessions: WorkspaceSessions, session: Session, signal?: AbortSignal, autoReload = false) {
  const check = checkpoint(session)
  if (!current(sessions, check)) return
  try {
    let changed: boolean
    if (editable(session)) changed = (await api.textRevision(check.path, signal)).revision !== check.revision
    else {
      const metadata = await api.metadata(check.path, signal)
      changed = metadata.mtime !== session.metadata?.mtime || metadata.size !== session.metadata?.size || metadata.viewer !== session.viewer
    }
    if (current(sessions, check) && changed) {
      sessions.markExternal(check.path, 'changed')
      if (autoReload && !session.dirty && !['error', 'conflict'].includes(session.state)) {
        try { await reloadCleanSession(sessions, session, signal) }
        catch (error) {
          if (sessions.has(check.path) && sessions.get(check.path) === session && (session.dirty || session.locked || session.pendingUploads || session.state === 'saving')) { sessions.markExternal(check.path, 'changed'); return }
          throw error
        }
      }
    }
  } catch (error) {
    if (!current(sessions, check) || signal?.aborted) return
    if (error instanceof ApiError && error.status === 404) sessions.markExternal(check.path, 'missing')
    else if (error instanceof ApiError && [413, 415].includes(error.status)) sessions.markExternal(check.path, 'changed')
    else throw error
  }
}

export async function reloadCleanSession(sessions: WorkspaceSessions, session: Session, parentSignal?: AbortSignal) {
  const check = checkpoint(session)
  const safe = () => !parentSignal?.aborted && current(sessions, check) && !session.dirty && !['error', 'conflict'].includes(session.state)
  if (!safe()) throw new Error('本地有修改或操作尚未结束，请先保留草稿并比较版本')
  const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
  const metadata = await api.metadata(check.path, signal)
  const file = ['markdown', 'text'].includes(metadata.viewer) ? await api.read(check.path, signal) : undefined
  if (!safe()) throw new Error('读取期间本地又有变化，已保留当前正文，请重试')
  sessions.acceptRemote(check.path, file?.content ?? '', file?.revision ?? '', true)
  sessions.setMetadata(check.path, metadata)
}
