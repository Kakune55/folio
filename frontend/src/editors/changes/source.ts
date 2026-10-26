import { RangeSet, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import type { ExternalUpdate } from '../../sessions/external-marks'
import { changeDetails, changePeek } from './details'
import type { ChangeDetail } from './details'

export const clearSourceChangeMarks = StateEffect.define<void>()
export function sourceChangeMarks(update?: ExternalUpdate) {
  const clear = clearSourceChangeMarks
  const toggle = StateEffect.define<number | null>()
  const peek = StateField.define<{ index: number; detail: ChangeDetail } | null>({
    create: () => null,
    update(value, transaction) {
      if (transaction.docChanged || transaction.effects.some(effect => effect.is(clear))) return null
      for (const effect of transaction.effects) {
        if (!effect.is(toggle)) continue
        if (effect.value === null || value?.index === effect.value) return null
        const mark = update?.marks[effect.value]
        if (!mark || update?.previousSource === undefined || !transaction.startState.field(markerField).size) return value
        const before = update.previousSource
        const details = changeDetails(before.replace(/\r\n|\r/g, '\n'), transaction.state.doc.toString())
        const lastLine = transaction.state.doc.lines
        const lastContentLine = Math.max(1, lastLine - (transaction.state.doc.line(lastLine).length === 0 ? 1 : 0))
        const detail = details.find(detail => mark.kind === 'deleted'
          ? !!detail.before && mark.line === Math.min(detail.after ? detail.to + 1 : detail.from, lastContentLine)
          : !!detail.after && mark.line >= detail.from && mark.line <= detail.to)
        if (!detail) return value
        // 比较使用 LF 坐标，展示从原文截取，保留旧内容的混合换行。
        const lines = before.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? []
        value = { index: effect.value, detail: { ...detail, before: detail.before ? lines.slice(detail.oldFrom - 1, detail.oldTo).join('') : '' } }
      }
      return value
    },
  })
  function close(view: EditorView) {
    const index = view.state.field(peek)?.index
    view.dispatch({ effects: update?.expiresAt !== null && Date.now() >= (update?.expiresAt ?? 0) ? clear.of() : toggle.of(null) })
    const marker = index === undefined ? null : view.dom.querySelector<HTMLElement>(`[data-external-mark="${index}"]`)
    if (marker) marker.focus({ preventScroll: true }); else view.focus()
  }
  class PeekWidget extends WidgetType {
    readonly detail: ChangeDetail
    constructor(detail: ChangeDetail) { super(); this.detail = detail }
    toDOM(view: EditorView) { return changePeek(this.detail.before, this.detail.after, () => close(view)) }
  }
  class Marker extends GutterMarker {
    readonly kind: string
    readonly edge?: string
    readonly count?: number
    readonly index: number
    readonly expanded: boolean
    constructor(kind: string, index: number, expanded: boolean, edge?: string, count?: number) { super(); this.kind = kind; this.index = index; this.expanded = expanded; this.edge = edge; this.count = count }
    toDOM(view: EditorView) {
      const marker = document.createElement('span')
      marker.className = `external-gutter-mark external-${this.kind}${this.edge ? ` external-${this.edge}` : ''}`
      marker.title = this.kind === 'deleted' ? `此处删除 ${this.count ?? 1} 行` : this.kind === 'inserted' ? '外部新增行' : '外部修改行'
      marker.setAttribute('aria-label', marker.title)
      marker.setAttribute('role', 'button')
      marker.setAttribute('aria-expanded', String(this.expanded))
      marker.dataset.externalMark = String(this.index)
      marker.tabIndex = 0
      marker.onmousedown = event => { event.preventDefault(); event.stopPropagation() }
      marker.onclick = event => {
        event.preventDefault(); event.stopPropagation()
        if (view.state.field(peek)?.index === this.index) close(view)
        else view.dispatch({ effects: toggle.of(this.index) })
        view.dom.querySelector<HTMLElement>(`[data-external-mark="${this.index}"]`)?.focus({ preventScroll: true })
      }
      marker.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); marker.click() }
        else if (event.key === 'Escape' && view.state.field(peek)) { event.preventDefault(); event.stopPropagation(); close(view) }
      }
      return marker
    }
  }
  const active = !!update && (update.expiresAt === null || update.expiresAt > Date.now())
  const markerField = StateField.define<RangeSet<GutterMarker>>({
    create(state) { return RangeSet.of(active ? update!.marks.map((mark, index) => new Marker(mark.kind, index, false, mark.edge, mark.count).range(state.doc.line(Math.min(mark.line, state.doc.lines)).from)) : [], true) },
    update(value, transaction) {
      if (transaction.docChanged || transaction.effects.some(effect => effect.is(clear))) return RangeSet.empty
      if (!value.size || !transaction.effects.some(effect => effect.is(toggle))) return value
      const selected = transaction.state.field(peek)?.index
      return RangeSet.of(update!.marks.map((mark, index) => new Marker(mark.kind, index, selected === index, mark.edge, mark.count).range(transaction.state.doc.line(Math.min(mark.line, transaction.state.doc.lines)).from)), true)
    },
  })
  const decorations = StateField.define<DecorationSet>({
    create(state) { return Decoration.set(active ? update!.marks.filter(mark => mark.kind !== 'deleted').map(mark => Decoration.line({ class: `external-line-${mark.kind}` }).range(state.doc.line(Math.min(mark.line, state.doc.lines)).from)) : [], true) },
    update(value, transaction) { return transaction.docChanged || transaction.effects.some(effect => effect.is(clear)) ? Decoration.none : value },
    provide: field => EditorView.decorations.from(field),
  })
  const peekDecorations = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      const current = transaction.state.field(peek)
      if (current === transaction.startState.field(peek)) return value
      if (!current) return Decoration.none
      const line = transaction.state.doc.line(Math.min(update!.marks[current.index].line, transaction.state.doc.lines))
      return Decoration.set(Decoration.widget({ widget: new PeekWidget(current.detail), block: true, side: 1 }).range(line.to))
    },
    provide: field => EditorView.decorations.from(field),
  })
  return [peek, markerField, decorations, peekDecorations, gutter({ class: 'external-change-gutter', markers: view => view.state.field(markerField) }),
    EditorView.domEventHandlers({ keydown(event, view) {
      if (event.key !== 'Escape' || !view.state.field(peek)) return false
      event.preventDefault(); close(view); return true
    } }),
    EditorView.theme({
      '.external-change-gutter': { width: '7px' },
      '.external-gutter-mark': { cursor: 'pointer' },
      '.external-gutter-mark:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '2px' },
    }),
    // 插件只派发装饰效果，不改文档，不加入历史；销毁清理定时器。
    expiryPlugin(update?.expiresAt, view => { if (!view.state.field(peek)) view.dispatch({ effects: clear.of() }) }),
  ]
}
function expiryPlugin(expiresAt: number | null | undefined, clear: (view: EditorView) => void) {
  return ViewPlugin.define(view => {
    const timer = expiresAt ? setTimeout(() => clear(view), Math.max(0, expiresAt - Date.now())) : undefined
    return { destroy: () => { if (timer) clearTimeout(timer) } }
  })
}
