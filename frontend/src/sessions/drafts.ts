import type { Session, WorkspaceSessions } from './workspace'

export type Draft = {
  version: 1; id: string; scope: string; token: string; path: string
  source: string; original: string; revision: string; viewer: 'markdown' | 'text'; updatedAt: number
}
export type DraftSummary = { id: string; path: string; updatedAt: number; invalid: boolean }
type DraftStatus = { phase: 'opening' | 'pending' | 'ready' | 'failed'; warning: string; entries: DraftSummary[] }
const validPath = (path: string) => !!path && path.length <= 4096 && !Array.from(path).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\') && path.split('/').every((part) => !!part && part !== '.' && part !== '..' && !part.startsWith('.folio-tmp-'))
export function validDraft(value: unknown, scope: string): value is Draft {
  if (!value || typeof value !== 'object') return false
  const draft = value as Partial<Draft>
  return draft.version === 1 && draft.scope === scope && typeof draft.id === 'string' && draft.id.length <= 128 && typeof draft.token === 'string' && typeof draft.path === 'string' && validPath(draft.path) && typeof draft.source === 'string' && typeof draft.original === 'string' && typeof draft.revision === 'string' && /^sha256:[a-f0-9]{64}$/.test(draft.revision) && (draft.viewer === 'markdown' || draft.viewer === 'text') && typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt)
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let finished = false
    const fail = () => { if (!finished) { finished = true; clearTimeout(timer); reject(new Error('浏览器恢复存储无法打开；请检查存储权限或其他页面是否阻塞升级')) } }
    const timer = setTimeout(fail, 5000)
    let request: IDBOpenDBRequest
    try { request = indexedDB.open('folio-recovery', 1) } catch { fail(); return }
    request.onupgradeneeded = () => { const store = request.result.createObjectStore('drafts', { keyPath: 'id' }); store.createIndex('scope', 'scope') }
    request.onblocked = fail; request.onerror = fail
    request.onsuccess = () => {
      clearTimeout(timer)
      if (finished) { request.result.close(); return }
      finished = true
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
  })
}
function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error ?? new Error('浏览器恢复存储事务未完成')); transaction.onerror = () => {} })
}

// 每个编辑会话使用独立随机键；多个页面不覆盖彼此的草稿。正文不进入 React/Zustand。
export class DraftManager {
  private db?: Promise<IDBDatabase>
  private pending = new Map<string, Draft | null>()
  private seen = new Map<string, Draft | null>()
  private queue = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private started = false
  private channel?: BroadcastChannel
  private refreshTimer?: ReturnType<typeof setTimeout>
  private listeners = new Set<() => void>()
  private state: DraftStatus = { phase: 'opening', warning: '', entries: [] }
  readonly scope: string
  private sessions: WorkspaceSessions
  constructor(scope: string, sessions: WorkspaceSessions) { this.scope = scope; this.sessions = sessions }
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(patch: Partial<DraftStatus>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()) }
  private failed(error: unknown) { this.set({ phase: 'failed', warning: `浏览器恢复副本未能更新：${error instanceof Error ? error.message : '存储失败'}。当前正文仍在页面中，请保存到磁盘或下载草稿。` }) }
  start() {
    if (this.started) return
    this.started = true
    this.db = openDatabase()
    this.sessions.watchBuffers(() => this.capture())
    this.capture()
    void this.db.then(async () => { await this.refresh(); await this.flush() }).catch((error) => this.failed(error))
    const flush = () => { this.capture(); void this.flush().catch(() => {}) }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
    try {
      this.channel = new BroadcastChannel('folio-recovery')
      this.channel.onmessage = (event) => { if (event.data === this.scope) { clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => void this.refresh().catch((error) => this.failed(error)), 500) } }
    } catch { /* 不支持广播时，打开恢复窗口仍会重新读取本机记录。 */ }
  }
  private capture() {
    const active = new Set<string>()
    for (const session of this.sessions.list()) {
      active.add(session.id)
      const old = this.seen.get(session.id)
      if (!session.dirty || !['markdown', 'text'].includes(session.viewer)) {
        if (old) { this.pending.set(session.id, null); this.seen.set(session.id, null) }
        continue
      }
      if (old && old.path === session.path && old.source === session.source && old.original === session.original && old.revision === session.revision && old.viewer === session.viewer) continue
      const draft = this.record(session)
      this.seen.set(session.id, draft); this.pending.set(session.id, draft)
    }
    for (const [id, old] of this.seen) if (!active.has(id)) { if (old) this.pending.set(id, null); this.seen.delete(id) }
    if (!this.pending.size || this.state.phase === 'failed') return
    if (this.state.phase !== 'pending') this.set({ phase: 'pending' })
    clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush().catch(() => {}), 150)
  }
  private record(session: Session): Draft {
    return { version: 1, id: session.id, scope: this.scope, token: crypto.randomUUID(), path: session.path, source: session.source, original: session.original, revision: session.revision, viewer: session.viewer as 'markdown' | 'text', updatedAt: Date.now() }
  }
  flush(): Promise<void> {
    clearTimeout(this.timer)
    const operation = this.queue.then(async () => {
      const db = await this.db
      if (!db) throw new Error('恢复存储尚未启动')
      const changes = new Map(this.pending); this.pending.clear()
      try {
        if (changes.size) {
          const transaction = db.transaction('drafts', 'readwrite', { durability: 'strict' })
          const done = transactionDone(transaction), store = transaction.objectStore('drafts')
          for (const [id, draft] of changes) { if (draft) store.put(draft); else store.delete(id) }
          await done
          this.channel?.postMessage(this.scope)
        }
        this.set({ phase: this.pending.size ? 'pending' : 'ready', warning: '' })
      } catch (error) {
        for (const [id, value] of changes) if (!this.pending.has(id)) this.pending.set(id, value)
        throw error
      }
    })
    this.queue = operation.catch((error) => this.failed(error))
    return operation
  }
  async retry() {
    // 初始化失败后允许重新打开；从不清空或重建已有恢复数据库。
    void this.db?.then((db) => db.close()).catch(() => {})
    this.db = openDatabase(); this.set({ phase: 'opening', warning: '' }); this.capture()
    await this.flush(); await this.refresh()
  }
  async refresh() {
    const db = await this.db
    if (!db) return
    const entries: DraftSummary[] = [], own = new Set(this.sessions.list().map((session) => session.id))
    const transaction = db.transaction('drafts', 'readonly'), done = transactionDone(transaction)
    const request = transaction.objectStore('drafts').index('scope').openCursor(IDBKeyRange.only(this.scope))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const value = cursor.value as Partial<Draft>, id = String(cursor.primaryKey)
      if (!own.has(id)) entries.push({ id, path: validDraft(value, this.scope) ? value.path : '格式不受支持的恢复记录', updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0, invalid: !validDraft(value, this.scope) })
      cursor.continue()
    }
    await done
    this.set({ entries: entries.sort((a, b) => b.updatedAt - a.updatedAt) })
  }
  async load(id: string): Promise<unknown> {
    const db = await this.db
    if (!db) throw new Error('恢复存储尚未启动')
    const transaction = db.transaction('drafts', 'readonly'), done = transactionDone(transaction)
    const request = transaction.objectStore('drafts').get(id)
    await done
    const value = request.result as Partial<Draft> | undefined
    if (!value || value.scope !== this.scope) throw new Error('恢复记录不存在或不属于当前工作区')
    return value
  }
  async remove(draft: unknown) {
    const snapshot = draft as Partial<Draft>
    const db = await this.db
    if (!db || typeof snapshot.id !== 'string' || snapshot.scope !== this.scope) throw new Error('恢复记录不属于当前工作区')
    const transaction = db.transaction('drafts', 'readwrite', { durability: 'strict' }), done = transactionDone(transaction)
    const store = transaction.objectStore('drafts'), request = store.get(snapshot.id)
    let changed = false
    request.onsuccess = () => {
      try { if (JSON.stringify(request.result) !== JSON.stringify(snapshot)) { changed = true; transaction.abort(); return } }
      catch { changed = true; transaction.abort(); return }
      store.delete(snapshot.id!)
    }
    try { await done } catch (error) { if (changed) throw new Error('恢复记录已被另一个页面更新，请重新读取后处理'); throw error }
    this.channel?.postMessage(this.scope); await this.refresh()
  }
}

let manager: DraftManager | undefined
export function getDraftManager(scope: string, sessions: WorkspaceSessions) {
  if (manager && manager.scope !== scope) throw new Error('工作区身份已变化，请保留草稿后重新加载页面')
  manager ??= new DraftManager(scope, sessions)
  return manager
}
