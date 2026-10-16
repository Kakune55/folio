import type { FileMetadata, ViewerKind } from '../services/api'

export type EditorMode = 'rich' | 'source'
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
export type Session = {
  path: string; source: string; original: string; mode: EditorMode; dirty: boolean
  revision: string; state: SaveState; error: string; generation: number
  viewer: ViewerKind; metadata?: FileMetadata; pendingUploads: number; locked: boolean
  external?: 'changed' | 'missing'
}
type FileInput = { path: string; source: string; mode: EditorMode; revision?: string; viewer?: ViewerKind; metadata?: FileMetadata }
type SaveTransport = (path: string, source: string, revision: string) => Promise<{ revision: string }>

// 正文只驻留在编辑会话中；全局状态仅管理导航和界面偏好。
export class WorkspaceSessions {
  private sessions = new Map<string, Session>()
  private listeners = new Set<() => void>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private pending = new Map<string, Promise<boolean>>()
  private version = 0
  private reservations = new Set<string>()
  private transport?: SaveTransport
  constructor(files: FileInput[] = [], transport?: SaveTransport) { this.transport = transport; files.forEach((file) => this.add(file)) }
  add(file: FileInput) {
    // 已打开的脏会话永远不被重新获取的远端内容覆盖。
    const existing = this.sessions.get(file.path)
    if (existing) return existing
    if (this.isLocked(file.path)) throw new Error('该路径正在进行文件操作，请稍后再打开')
    const session: Session = { ...file, original: file.source, dirty: false, revision: file.revision ?? '', state: 'saved', error: '', generation: 0, viewer: file.viewer ?? (/\.(md|markdown)$/i.test(file.path) ? 'markdown' : 'text'), pendingUploads: 0, locked: false }
    this.sessions.set(file.path, session); this.emit(); return session
  }
  has(path: string) { return this.sessions.has(path) }
  get(path: string) { const session = this.sessions.get(path); if (!session) throw new Error('文件会话不存在'); return session }
  list() { return [...this.sessions.values()] }
  update(path: string, source: string) {
    const session = this.get(path)
    session.source = source
    const dirty = source !== session.original || ['saving', 'error', 'conflict'].includes(session.state)
    const state: SaveState = session.external ? 'conflict' : session.state === 'saving' || session.state === 'error' || session.state === 'conflict' ? session.state : dirty ? 'dirty' : 'saved'
    const changed = dirty !== session.dirty || state !== session.state
    session.dirty = dirty; session.state = state
    if (session.external) { session.dirty = true; session.error = '磁盘文件已变化，本地草稿仍保留，请比较版本或另存副本' }
    if (changed) this.emit()
    this.schedule(session)
  }
  private schedule(session: Session, delay = 800) {
    const previous = this.timers.get(session.path); if (previous) clearTimeout(previous)
    this.timers.delete(session.path)
    if (session.locked || !this.transport || !session.dirty || ['conflict', 'error', 'saving'].includes(session.state)) return
    this.timers.set(session.path, setTimeout(() => { this.timers.delete(session.path); void this.save(session.path) }, delay))
  }
  save(path: string, duringOperation = false): Promise<boolean> {
    const session = this.get(path)
    if (session.locked && !duringOperation) return Promise.resolve(false)
    const pending = this.pending.get(path); if (pending) return pending
    const timer = this.timers.get(path); if (timer) clearTimeout(timer); this.timers.delete(path)
    if (!this.transport || !session.dirty) return Promise.resolve(!session.dirty)
    if (session.state === 'conflict' || session.external) return Promise.resolve(false)
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
  async flush(path: string, duringOperation = false) {
    if (this.get(path).locked && !duringOperation) return false
    if (this.get(path).pendingUploads) return false
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await this.save(path, duringOperation)
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
    session.state = 'saved'; session.error = ''; session.external = undefined; session.generation++; this.emit()
  }
  markExternal(path: string, external: 'changed' | 'missing') {
    const session = this.get(path)
    if (session.external === external) return
    session.external = external
    const timer = this.timers.get(path); if (timer) clearTimeout(timer); this.timers.delete(path)
    if (session.dirty) { session.state = 'conflict'; session.error = external === 'missing' ? '原文件已被移走或删除，本地草稿仍保留，可另存副本' : '磁盘文件已变化，本地草稿仍保留，请比较版本' }
    this.emit()
  }
  remove(path: string, duringOperation = false) {
    const session = this.get(path)
    if ((session.locked && !duringOperation) || session.dirty || session.pendingUploads || this.pending.has(path)) return false
    const timer = this.timers.get(path); if (timer) clearTimeout(timer); this.timers.delete(path)
    this.sessions.delete(path); this.emit(); return true
  }
  isLocked(path: string) { return [...this.reservations].some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) }
  lockTree(prefix: string, target?: string) {
    const prefixes = [prefix, ...(target ? [target] : [])]
    if (prefixes.some((path) => this.isLocked(path) || [...this.reservations].some((reserved) => reserved.startsWith(`${path}/`)))) throw new Error('相关路径正在进行文件操作，请稍后重试')
    const affected = this.list().filter((session) => session.path === prefix || session.path.startsWith(`${prefix}/`))
    if (affected.some((session) => session.locked || session.pendingUploads)) throw new Error('文件操作或图片上传尚未结束，请稍后重试')
    for (const session of affected) { session.locked = true; const timer = this.timers.get(session.path); if (timer) clearTimeout(timer); this.timers.delete(session.path) }
    prefixes.forEach((path) => this.reservations.add(path))
    this.emit(); return affected
  }
  unlock(affected: Session[], prefixes: string[]) { prefixes.forEach((path) => this.reservations.delete(path)); for (const session of affected) { session.locked = false; if (this.has(session.path)) this.schedule(session) }; this.emit() }
  canRemap(from: string, to: string) {
    const affected = this.list().filter((session) => session.path === from || session.path.startsWith(`${from}/`))
    return affected.every((session) => !this.sessions.has(to + session.path.slice(from.length)))
  }
  remap(from: string, to: string) {
    if (!this.canRemap(from, to)) throw new Error('目标路径已有编辑会话，请先保存并关闭该标签页')
    const affected = this.list().filter((session) => session.path === from || session.path.startsWith(`${from}/`))
    for (const session of affected) {
      const old = session.path; this.sessions.delete(old); const timer = this.timers.get(old); if (timer) clearTimeout(timer); this.timers.delete(old)
      session.path = to + old.slice(from.length); session.generation++
      if (session.metadata) session.metadata = { ...session.metadata, path: session.path }
      this.sessions.set(session.path, session)
    }
    this.emit()
  }
  setMetadata(path: string, metadata: FileMetadata) {
    const session = this.get(path); session.metadata = metadata; session.viewer = metadata.viewer
    if (metadata.viewer !== 'markdown') session.mode = 'source'
    session.generation++; this.emit()
  }
  operationFailed(affected: Session[], message: string, conflict: boolean) {
    for (const session of affected) { session.dirty = true; session.state = conflict ? 'conflict' : 'error'; session.error = message }
    this.emit()
  }
  beginUpload(path: string) { const session = this.get(path); if (session.locked || this.isLocked(path)) return false; session.pendingUploads++; this.emit(); return true }
  endUpload(path: string) { this.get(path).pendingUploads--; this.emit() }
  appendAttachment(path: string, markdown: string) {
    const session = this.get(path)
    const separator = session.source.endsWith('\n\n') || !session.source ? '' : session.source.endsWith('\n') ? '\n' : '\n\n'
    this.update(path, `${session.source}${separator}${markdown}\n`)
    session.generation++; this.emit()
  }
  setMode(path: string, mode: EditorMode) { const session = this.get(path); if (session.mode === mode) return; session.mode = mode; this.emit() }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.version
  private emit() { this.version++; this.listeners.forEach((listener) => listener()) }
}
