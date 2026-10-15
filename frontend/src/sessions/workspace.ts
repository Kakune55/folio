export type EditorMode = 'rich' | 'source'
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
export type Session = {
  path: string; source: string; original: string; mode: EditorMode; dirty: boolean
  revision: string; state: SaveState; error: string; generation: number
}
type FileInput = { path: string; source: string; mode: EditorMode; revision?: string }
type SaveTransport = (path: string, source: string, revision: string) => Promise<{ revision: string }>

// 正文只驻留在编辑会话中；全局状态仅管理导航和界面偏好。
export class WorkspaceSessions {
  private sessions = new Map<string, Session>()
  private listeners = new Set<() => void>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private pending = new Map<string, Promise<boolean>>()
  private version = 0
  private transport?: SaveTransport
  constructor(files: FileInput[] = [], transport?: SaveTransport) { this.transport = transport; files.forEach((file) => this.add(file)) }
  add(file: FileInput) {
    // 已打开的脏会话永远不被重新获取的远端内容覆盖。
    const existing = this.sessions.get(file.path)
    if (existing) return existing
    const session: Session = { ...file, original: file.source, dirty: false, revision: file.revision ?? '', state: 'saved', error: '', generation: 0 }
    this.sessions.set(file.path, session); this.emit(); return session
  }
  has(path: string) { return this.sessions.has(path) }
  get(path: string) { const session = this.sessions.get(path); if (!session) throw new Error('文件会话不存在'); return session }
  list() { return [...this.sessions.values()] }
  update(path: string, source: string) {
    const session = this.get(path)
    session.source = source
    const dirty = source !== session.original || ['saving', 'error', 'conflict'].includes(session.state)
    const state: SaveState = session.state === 'saving' || session.state === 'error' || session.state === 'conflict' ? session.state : dirty ? 'dirty' : 'saved'
    const changed = dirty !== session.dirty || state !== session.state
    session.dirty = dirty; session.state = state
    if (changed) this.emit()
    this.schedule(session)
  }
  private schedule(session: Session, delay = 800) {
    const previous = this.timers.get(session.path); if (previous) clearTimeout(previous)
    this.timers.delete(session.path)
    if (!this.transport || !session.dirty || ['conflict', 'error', 'saving'].includes(session.state)) return
    this.timers.set(session.path, setTimeout(() => { this.timers.delete(session.path); void this.save(session.path) }, delay))
  }
  save(path: string): Promise<boolean> {
    const session = this.get(path)
    const pending = this.pending.get(path); if (pending) return pending
    const timer = this.timers.get(path); if (timer) clearTimeout(timer); this.timers.delete(path)
    if (!this.transport || !session.dirty) return Promise.resolve(!session.dirty)
    if (session.state === 'conflict') return Promise.resolve(false)
    const source = session.source
    session.state = 'saving'; session.error = ''; this.emit()
    const operation = this.transport(path, source, session.revision).then((response) => {
      session.revision = response.revision; session.original = source; session.dirty = session.source !== source
      session.state = session.dirty ? 'dirty' : 'saved'; this.emit(); return true
    }).catch((error: unknown) => {
      const code = error instanceof Error && 'code' in error ? error.code : ''
      session.state = code === 'revision_conflict' || code === 'not_found' ? 'conflict' : 'error'
      session.error = error instanceof Error ? error.message : '保存失败，草稿仍保留'; this.emit(); return false
    }).finally(() => { this.pending.delete(path); this.schedule(session, 0) })
    this.pending.set(path, operation)
    return operation
  }
  async flush(path: string) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await this.save(path)
      if (!result) return false
      if (!this.get(path).dirty) return true
    }
    return false
  }
  // 只在用户已下载/保留本地副本后，通过显式操作加载远端内容。
  acceptRemote(path: string, source: string, revision: string) {
    if (this.pending.has(path)) throw new Error('保存尚未结束，请稍后重试')
    const session = this.get(path)
    const timer = this.timers.get(path); if (timer) clearTimeout(timer); this.timers.delete(path)
    session.source = source; session.original = source; session.revision = revision; session.dirty = false
    session.state = 'saved'; session.error = ''; session.generation++; this.emit()
  }
  remove(path: string) {
    const session = this.get(path)
    if (session.dirty || this.pending.has(path)) return false
    const timer = this.timers.get(path); if (timer) clearTimeout(timer); this.timers.delete(path)
    this.sessions.delete(path); this.emit(); return true
  }
  setMode(path: string, mode: EditorMode) { const session = this.get(path); if (session.mode === mode) return; session.mode = mode; this.emit() }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.version
  private emit() { this.version++; this.listeners.forEach((listener) => listener()) }
}
