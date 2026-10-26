import { lineDiff } from '../../components/diff/line-diff'

export type ChangeDetail = { from: number; to: number; oldFrom: number; oldTo: number; before: string; after: string }
export function changeDetails(before: string, after: string): ChangeDetail[] {
  if (before.length + after.length > 1_000_000 || (before.match(/\r\n|\r|\n/g)?.length ?? 0) > 20000 || (after.match(/\r\n|\r|\n/g)?.length ?? 0) > 20000) return []
  const details: ChangeDetail[] = []
  let current: ChangeDetail | undefined, position = 1
  for (const row of lineDiff(before, after).rows) {
    if (!row || row.kind === 'equal') { if (current) details.push(current); current = undefined; if (row?.after) position = row.after + 1; continue }
    current ??= { from: position, to: position, oldFrom: row.before ?? 0, oldTo: row.before ?? 0, before: '', after: '' }
    if (row.kind === 'delete') { current.before += row.text; if (!current.oldFrom) current.oldFrom = row.before!; current.oldTo = row.before! }
    else { current.after += row.text; current.to = row.after!; position = row.after! + 1 }
  }
  if (current) details.push(current)
  return details
}

export function changePeek(before: string, after: string, close: () => void) {
  const root = document.createElement('div'); root.className = 'external-change-peek'; root.contentEditable = 'false'
  root.setAttribute('role', 'region'); root.setAttribute('aria-label', '外部修改详情')
  const button = document.createElement('button'); button.type = 'button'; button.className = 'button external-change-peek-close'; button.textContent = '收起'; button.onclick = close
  root.append(button)
  let remainingLines = 200, remainingCharacters = 20_000
  for (const [label, content, kind] of [['修改前', before, 'delete'], ['修改后', after, 'insert']]) {
    if (!content) continue
    const pre = document.createElement('pre'); pre.className = `diff-${kind}`; pre.tabIndex = 0; pre.setAttribute('aria-label', label)
    const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? []
    const displayed = lines.slice(0, remainingLines).join('').slice(0, remainingCharacters)
    pre.textContent = displayed
    remainingLines = Math.max(0, remainingLines - Math.min(lines.length, remainingLines)); remainingCharacters -= displayed.length
    root.append(pre)
    if (displayed.length < content.length) { const warning = document.createElement('p'); warning.textContent = '内容较长，展开区域合计最多显示 200 行／20000 字符；完整正文仍保留在编辑会话中。'; root.append(warning) }
  }
  root.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } })
  return root
}
