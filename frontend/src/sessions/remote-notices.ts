import { api } from '../services/api'
import type { FileContent } from '../services/api'
import { lineDiff } from '../components/diff/line-diff'
import type { Session, WorkspaceSessions } from './workspace'

export type RemoteNotice = {
  session: Session; path: string; before: string; remote: FileContent
  source?: string; deadline: number | null; busy: boolean; error: string
  inserted: number; deleted: number; limited: boolean
}

function summary(before: string, after: string) {
  const count = (text: string) => {
    let lines = 0, end = 0
    for (const match of text.matchAll(/\r\n|\r|\n/g)) { lines++; end = match.index + match[0].length }
    return lines + (end < text.length ? 1 : 0)
  }
  // 与编辑器标记共用量级预算；大正文只作线性计数，不构建逐行对象。
  const deleted = count(before), inserted = count(after)
  if (before.length + after.length > 1_000_000 || deleted > 20000 || inserted > 20000) return { inserted, deleted, limited: true }
  return lineDiff(before, after)
}

// 候选正文留在独立会话协调器，React 只订阅通知的变化。
export class RemoteNotices {
  private entries = new Map<string, RemoteNotice>()
  private listeners = new Set<() => void>()
  private version = 0
  private sessions: WorkspaceSessions
  constructor(sessions: WorkspaceSessions) { this.sessions = sessions }
  list = () => [...this.entries.values()]
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.version
  private emit() { this.version++; this.listeners.forEach(listener => listener()) }
  private valid(entry: RemoteNotice) { return this.sessions.has(entry.path) && this.sessions.get(entry.path) === entry.session && entry.session.path === entry.path }
  prune() {
    for (const entry of this.entries.values()) if (!this.valid(entry)) { this.entries.delete(entry.path); this.emit() }
  }
  async check(session: Session, signal?: AbortSignal, source?: string) {
    const path = session.path, revision = session.revision, generation = session.generation, baseline = session.original
    const valid = () => this.sessions.has(path) && this.sessions.get(path) === session && session.path === path && session.revision === revision && session.generation === generation && !session.locked && !session.pendingUploads && session.state !== 'saving'
    const result = await api.textRevision(path, signal)
    if (!valid()) return
    const existing = this.entries.get(path)
    if (result.revision === revision) {
      return
    }
    this.sessions.markExternal(path, 'changed')
    if (existing?.remote.revision === result.revision) return
    const remote = await api.read(path, signal)
    if (!valid() || signal?.aborted) return
    if (remote.revision === revision) return
    if (this.entries.get(path)?.remote.revision === remote.revision) return
    let metadata: Awaited<ReturnType<typeof api.metadata>> | undefined
    if (!session.dirty && !['error', 'conflict'].includes(session.state)) {
      metadata = await api.metadata(path, signal)
      if (!valid() || signal?.aborted) return
    }
    // 读取期间可能已接受上一轮；只能合并仍待确认的通知，不能复活旧回滚基准。
    const previous = this.entries.get(path), before = previous?.before ?? baseline
    const diff = summary(before, remote.content)
    if (metadata && !session.dirty && !['error', 'conflict'].includes(session.state)) {
      this.sessions.acceptRemote(path, remote.content, remote.revision, 'notice', before)
      this.sessions.setMetadata(path, metadata)
    }
    this.entries.set(path, { session, path, before, remote, source,
      deadline: previous?.deadline === null || session.dirty ? null : Date.now() + 10_000,
      busy: false, error: '', inserted: diff.inserted, deleted: diff.deleted, limited: diff.limited })
    this.emit()
  }
  wait(entry: RemoteNotice) {
    if (this.entries.get(entry.path) !== entry) return
    entry.deadline = null; this.emit()
  }
  async accept(entry: RemoteNotice): Promise<'accepted' | 'conflict' | undefined> {
    if (this.entries.get(entry.path) !== entry || !this.valid(entry) || entry.busy) return
    this.wait(entry)
    const session = entry.session
    if (session.dirty || ['error', 'conflict'].includes(session.state)) return 'conflict'
    if (session.locked || session.pendingUploads || session.state === 'saving') { entry.error = '文件操作尚未结束，请稍后重试。'; this.emit(); return }
    this.sessions.clearExternalUpdate(entry.path)
    this.entries.delete(entry.path); this.emit(); return 'accepted'
  }
  async rollback(entry: RemoteNotice) {
    if (this.entries.get(entry.path) !== entry || !this.valid(entry) || entry.busy) return
    this.wait(entry)
    let locked: Session[] | undefined
    try {
      locked = this.sessions.lockTree(entry.path)
      if (entry.session.state === 'saving') throw new Error('保存尚未结束，请稍后重试。')
      entry.busy = true; entry.error = ''; this.emit()
      const saved = await api.write(entry.path, entry.before, entry.remote.revision)
      if (this.valid(entry)) this.sessions.acceptRollback(entry.path, entry.before, saved.revision)
      this.entries.delete(entry.path)
    } catch (error) { entry.error = `回滚未确认成功，当前正文已保留。${error instanceof Error ? error.message : '请重新检查磁盘版本。'}` }
    finally { if (locked) this.sessions.unlock(locked, [entry.path]); entry.busy = false; this.emit() }
  }
}
