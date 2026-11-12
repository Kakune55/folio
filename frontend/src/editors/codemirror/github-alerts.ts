import type { EditorState } from '@codemirror/state'
import { WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

const alerts = {
  NOTE: { label: '注意', paths: ['M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0Z', 'M12 11v6', 'M12 7h.01'] },
  TIP: { label: '提示', paths: ['M9 18h6', 'M10 22h4', 'M9 14a6 6 0 1 1 6 0c-1 .8-1 1.5-1 4h-4c0-2.5 0-3.2-1-4Z'] },
  IMPORTANT: { label: '重要', paths: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z', 'M12 7v4', 'M12 14h.01'] },
  WARNING: { label: '警告', paths: ['m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z', 'M12 9v4', 'M12 17h.01'] },
  CAUTION: { label: '危险', paths: ['M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9Z', 'M12 8v4', 'M12 16h.01'] },
} as const
type AlertType = keyof typeof alerts

/** 仅识别顶层引用首行的完整标记，不引入第二套正文或块模型。 */
export function githubAlert(state: EditorState, node: SyntaxNode) {
  if (node.name !== 'Blockquote' || node.parent?.name !== 'Document') return
  const quote = node.firstChild
  if (quote?.name !== 'QuoteMark') return
  const line = state.doc.lineAt(quote.from)
  if (line.to - quote.to > 80) return
  const raw = state.sliceDoc(quote.to, line.to)
  const match = /^[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/.exec(raw)
  if (!match) return
  const from = quote.to + raw.indexOf('[')
  return { type: match[1] as AlertType, from, to: from + match[1].length + 3 }
}

export class AlertTitle extends WidgetType {
  readonly type: AlertType
  constructor(type: AlertType) { super(); this.type = type }
  eq(other: AlertTitle) { return this.type === other.type }
  ignoreEvent() { return false }
  toDOM() {
    const title = document.createElement('span'), config = alerts[this.type]
    title.className = 'folio-alert-title'; title.dataset.alertType = this.type
    title.setAttribute('role', 'group'); title.setAttribute('aria-label', `提示块：${config.label}（${this.type}）`)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value)
    for (const d of config.paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', d); svg.append(path)
    }
    title.append(svg, document.createTextNode(config.label))
    return title
  }
}
