import type { EditorMode, Session } from './workspace'

export type ReadingPosition = { anchor: number; head: number; scrollTop: number; scrollLeft: number; mode: EditorMode }
type Entry = ReadingPosition & { path: string; revision: string }
const limit = 100

function entries(storage: Pick<Storage, 'getItem'>, key: string): Entry[] {
  const value: unknown = JSON.parse(storage.getItem(key) ?? '[]')
  if (!Array.isArray(value)) throw new Error('续写位置记录格式无效')
  return value.filter((entry): entry is Entry => entry && typeof entry.path === 'string' && typeof entry.revision === 'string'
    && (entry.mode === 'rich' || entry.mode === 'source')
    && [entry.anchor, entry.head].every(n => Number.isSafeInteger(n) && n >= 0)
    && [entry.scrollTop, entry.scrollLeft].every(n => Number.isFinite(n) && n >= 0)).slice(0, limit)
}

export const readingPositionKey = (workspaceId: string, userId: number) => `folio.position.v1:${userId}:${workspaceId}`

function canUseSavedPosition(session: Session) {
  return session.revision !== '' && !session.dirty && !session.external && !session.composing && !session.compositionInterrupted
}

export function readPosition(storage: Pick<Storage, 'getItem'>, key: string, session: Session) {
  if (!canUseSavedPosition(session)) return undefined
  return entries(storage, key).find(entry => entry.path === session.path && entry.revision === session.revision)
}

export function writePosition(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, session: Session, position: ReadingPosition) {
  if (!canUseSavedPosition(session)) return
  const previous = entries(storage, key)
  const next = { ...position, path: session.path, revision: session.revision }
  const first = previous[0]
  if (first && first.path === next.path && first.revision === next.revision && first.mode === next.mode
    && first.anchor === next.anchor && first.head === next.head && first.scrollTop === next.scrollTop && first.scrollLeft === next.scrollLeft) return
  storage.setItem(key, JSON.stringify([next, ...previous.filter(entry => entry.path !== session.path)].slice(0, limit)))
}
