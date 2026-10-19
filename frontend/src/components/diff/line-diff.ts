export type DiffLine = { kind: 'equal' | 'delete' | 'insert'; text: string; before?: number; after?: number }
const lines = (text: string) => text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? []
export function lineDiff(original: string, modified: string) {
  const a = lines(original), b = lines(modified), rows: DiffLine[] = []
  let start = 0, endA = a.length, endB = b.length
  while (start < endA && start < endB && a[start] === b[start]) start++
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const n = endA - start, m = endB - start
  const limited = n > 0 && m > 0 && (n + 1) * (m + 1) > 250000
  let i = start, j = start
  const push = (kind: DiffLine['kind']) => {
    rows.push({ kind, text: kind === 'insert' ? b[j] : a[i], before: kind === 'insert' ? undefined : i + 1, after: kind === 'delete' ? undefined : j + 1 })
    if (kind !== 'insert') i++
    if (kind !== 'delete') j++
  }
  // 有界 LCS；大替换区间明确退为完整删除/新增，避免二次方资源消耗。
  if (!limited && n && m) {
    const width = m + 1, table = new Uint32Array((n + 1) * width)
    for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) {
      table[x * width + y] = a[start + x] === b[start + y] ? table[(x + 1) * width + y + 1] + 1 : Math.max(table[(x + 1) * width + y], table[x * width + y + 1])
    }
    while (i < endA && j < endB) {
      if (a[i] === b[j]) push('equal')
      else if (table[(i - start + 1) * width + j - start] >= table[(i - start) * width + j - start + 1]) push('delete')
      else push('insert')
    }
  }
  while (i < endA) push('delete')
  while (j < endB) push('insert')
  // 只保留差异周围三行上下文；首尾大段相同行不进入 DOM。
  const visible: (DiffLine | null)[] = []
  const context: DiffLine[] = []
  for (let x = Math.max(0, start - 3); x < start; x++) context.push({ kind: 'equal', text: a[x], before: x + 1, after: x + 1 })
  for (let x = 0; x < Math.min(3, a.length - endA); x++) rows.push({ kind: 'equal', text: a[endA + x], before: endA + x + 1, after: endB + x + 1 })
  const all = [...context, ...rows]
  for (let x = 0; x < all.length;) {
    if (all[x].kind !== 'equal') { visible.push(all[x++]); continue }
    let end = x
    while (end < all.length && all[end].kind === 'equal') end++
    if (end - x > 6) visible.push(...all.slice(x, x + 3), null, ...all.slice(end - 3, end))
    else visible.push(...all.slice(x, end))
    x = end
  }
  return { rows: visible, limited, deleted: rows.filter(r => r.kind === 'delete').length, inserted: rows.filter(r => r.kind === 'insert').length }
}
export function displayLine(line: string) {
  return line.endsWith('\r\n') ? `${line.slice(0, -2)} [CRLF]` : line.endsWith('\r') ? `${line.slice(0, -1)} [CR]` : line.endsWith('\n') ? `${line.slice(0, -1)} [LF]` : `${line} [EOF]`
}
