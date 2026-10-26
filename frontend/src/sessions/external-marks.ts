import { lineDiff } from '../components/diff/line-diff'
export type ExternalMark = { line: number; kind: 'modified' | 'inserted' | 'deleted'; edge?: 'before' | 'after'; count?: number }
// null 表示由远程通知决策管理，不允许编辑器独立过期。
export type ExternalUpdate = { id: string; previousSource?: string; marks: ExternalMark[]; limited: boolean; expiresAt: number | null }

export function externalMarks(before: string, after: string) {
  if (before.length + after.length > 1_000_000 || (before.match(/\r\n|\r|\n/g)?.length ?? 0) > 20000 || (after.match(/\r\n|\r|\n/g)?.length ?? 0) > 20000) return { marks: [] as ExternalMark[], limited: true }
  const diff = lineDiff(before, after)
  const count = after.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean).length ?? 0
  const marks: ExternalMark[] = []
  let previous = 0, removed = 0, anchor = 1
  let inserted: number[] = []
  const flush = () => {
    const paired = Math.min(removed, inserted.length)
    inserted.forEach((line, index) => marks.push({ line, kind: index < paired ? 'modified' : 'inserted' }))
    if (removed > paired) {
      const position = inserted.length ? inserted.at(-1)! + 1 : anchor
      marks.push({ line: Math.max(1, Math.min(position, count)), kind: 'deleted', edge: count > 0 && position > count ? 'after' : 'before', count: removed - paired })
    }
    removed = 0; inserted = []
  }
  for (const row of diff.rows) {
    if (!row || row.kind === 'equal') { flush(); if (row?.after) previous = row.after; continue }
    if (!removed && !inserted.length) anchor = previous + 1
    if (row.kind === 'delete') removed++
    else { inserted.push(row.after!); previous = row.after! }
  }
  flush()
  return { marks: marks.slice(0, 2000), limited: diff.limited || marks.length > 2000 }
}
