import type { Entry } from '../../services/api'

export function entryRange(visible: Entry[], anchor: string | null, target: Entry): Entry[] {
  const start = visible.findIndex(entry => entry.path === anchor)
  const end = visible.findIndex(entry => entry.path === target.path)
  if (start < 0 || end < 0) return [target]
  return visible.slice(Math.min(start, end), Math.max(start, end) + 1)
}

export function reconcileEntrySelection(selected: Map<string, Entry>, directory: string, snapshot: Entry[] | null): Map<string, Entry> {
  const entries = new Map(snapshot?.map(entry => [entry.path, entry]))
  let next = selected
  for (const [path, entry] of selected) {
    if (directory && !path.startsWith(`${directory}/`)) continue
    const name = (directory ? path.slice(directory.length + 1) : path).split('/')[0]
    const top = directory ? `${directory}/${name}` : name
    const current = entries.get(top)
    if (!current || (path === top ? current.kind !== entry.kind : current.kind !== 'directory')) {
      if (next === selected) next = new Map(selected)
      next.delete(path)
    }
  }
  return next
}
