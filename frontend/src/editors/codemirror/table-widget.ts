import { EditorState, type Text } from '@codemirror/state'
import { defaultKeymap, redo, undo } from '@codemirror/commands'
import { EditorView, keymap, WidgetType } from '@codemirror/view'
import { tableCellTransaction, tableNavigation, type tableAlignments } from './tables'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { TableControls } from './TableControls'

export type TableWidgetOptions = {
  canEdit?: () => boolean
  canEditCell?: () => boolean
  onBlocked?: (message: string) => void
  onCellComposition?: (active: boolean, view: EditorView, interrupted?: boolean) => void
}
type Cell = { from: number; to: number; text: string }
type Active = { view: EditorView; row: number; column: number; from: number; to: number; doc: Text; writing: boolean; composing: boolean }
const lives = new WeakMap<HTMLElement, { update: (widget: TableWidget) => void; destroy: () => void }>()

export function focusTableCell(view: EditorView) {
  view.dom.querySelectorAll('.folio-preview-table').forEach(root => root.dispatchEvent(new Event('folio-table-focus')))
}

export class TableWidget extends WidgetType {
  readonly rows: Cell[][]
  readonly raw: string
  readonly options: TableWidgetOptions
  readonly alignments: NonNullable<ReturnType<typeof tableAlignments>>
  readonly document: Text
  constructor(rows: Cell[][], raw: string, options: TableWidgetOptions, alignments: NonNullable<ReturnType<typeof tableAlignments>>, document: Text) {
    super(); this.rows = rows; this.raw = raw; this.options = options; this.alignments = alignments; this.document = document
  }
  eq(other: TableWidget) { return this.document === other.document && this.raw === other.raw && JSON.stringify(this.rows) === JSON.stringify(other.rows) && this.options === other.options }
  get estimatedHeight() { return this.rows.length * 38 + 48 }
  toDOM(outer: EditorView) {
    const root = document.createElement('div'), table = document.createElement('table')
    root.className = 'folio-preview-table'
    root.contentEditable = 'false'
    let widget = { rows: this.rows, options: this.options, alignments: this.alignments }
    let active: Active | undefined, destroyed = false, syncing = false
    const cells: HTMLElement[][] = []
    const writable = () => !destroyed && outer.dom.isConnected && !outer.state.readOnly && outer.state.facet(EditorView.editable) && (widget.options.canEditCell?.() ?? widget.options.canEdit?.() ?? true)
    const report = (message: string) => widget.options.onBlocked?.(message)
    const controlsHost = document.createElement('div')
    controlsHost.className = 'folio-table-local-controls'
    const controls = createRoot(controlsHost)
    const canControl = () => writable() && widget.options.canEdit?.() !== false && !outer.composing && !outer.compositionStarted && !active?.composing
    const prepareControls = () => {
      if (!canControl()) { report('当前不能编辑表格，请先处理未确认输入或文件操作。'); return false }
      const selection = outer.state.selection.main
      const selected = widget.rows.flat().find(cell => selection.from >= cell.from && selection.to <= cell.to)
      const cell = selected ?? (active?.doc === outer.state.doc ? active : widget.rows[0][0])
      outer.dispatch({ selection: { anchor: cell.from, head: cell.to } })
      return true
    }
    queueMicrotask(() => {
      if (!destroyed) controls.render(createElement(TableControls, { view: outer, disabled: false, local: prepareControls, canEdit: canControl, onBlocked: report }))
    })
    const close = () => {
      if (!active) return
      const previous = active; active = undefined
      if (previous.composing) widget.options.onCellComposition?.(false, previous.view, true)
      previous.view.destroy()
      const cell = cells[previous.row]?.[previous.column]
      if (cell) { cell.classList.remove('folio-table-active'); cell.textContent = widget.rows[previous.row]?.[previous.column]?.text ?? '' }
    }
    const focusSelection = () => {
      if (destroyed || !outer.dom.isConnected) return
      const selection = outer.state.selection.main
      for (const [row, values] of widget.rows.entries()) for (const [column, cell] of values.entries()) {
        if (selection.from >= cell.from && selection.to <= cell.to) { activate(row, column); return }
      }
    }
    const activate = (row: number, column: number) => {
      if (active?.composing) { report('请先确认或取消输入法候选，再切换单元格。'); return }
      if (!writable() || widget.options.canEdit?.() === false) { report('当前不能编辑单元格，请先处理未确认输入或文件操作。'); return }
      if (active?.row === row && active.column === column) { active.view.focus(); return }
      close()
      const cell = widget.rows[row]?.[column], td = cells[row]?.[column]
      if (!cell || !td) return
      // 先同步原文选区，现有行列工具与撤销始终作用于同一个外层文档。
      outer.dispatch({ selection: { anchor: cell.from, head: cell.to } })
      td.textContent = ''; td.classList.add('folio-table-active')
      const navigate = (backward: boolean) => {
        if (!active || active.composing || active.view.composing || active.view.compositionStarted) return false
        if (!writable()) { report('当前不能编辑表格。'); return true }
        const result = tableNavigation(outer.state, backward)
        if (!result) return false
        if ('error' in result) { report(result.error); return true }
        if ('boundary' in result) {
          close(); outer.dom.closest('.editor-content-column')?.querySelector<HTMLButtonElement>('[data-table-trigger]')?.focus(); return true
        }
        outer.dispatch(result); queueMicrotask(focusSelection); return true
      }
      const arrow = (direction: 'left' | 'right' | 'up' | 'down') => (view: EditorView) => {
        if (!active || active.composing || view.composing || view.compositionStarted) return false
        const selection = view.state.selection.main, length = view.state.doc.length
        if (!selection.empty) return false
        const horizontal = direction === 'left' || direction === 'right'
        const forward = direction === 'right' || direction === 'down'
        const boundary = horizontal ? selection.head : view.moveToLineBoundary(selection, forward, true).head
        if (boundary !== (forward ? length : 0)) return false
        const targetRow = active.row + (horizontal ? 0 : forward ? 1 : -1)
        const targetColumn = active.column + (horizontal ? forward ? 1 : -1 : 0)
        if (!widget.rows[targetRow]?.[targetColumn]) return false
        if (!writable()) { report('当前不能编辑表格。'); return true }
        const position = horizontal ? forward ? 0 : widget.rows[targetRow][targetColumn].text.length : selection.head
        queueMicrotask(() => {
          if (destroyed || !outer.dom.isConnected) return
          activate(targetRow, targetColumn)
          if (active?.row === targetRow && active.column === targetColumn) active.view.dispatch({ selection: { anchor: Math.min(position, active.view.state.doc.length) }, scrollIntoView: true })
        })
        return true
      }
      const input = new EditorView({ parent: td, state: EditorState.create({ doc: cell.text, selection: { anchor: 0, head: cell.text.length }, extensions: [
        EditorView.contentAttributes.of({ 'aria-label': `表格第 ${row === 0 ? '表头' : row} 行，第 ${column + 1} 列`, 'aria-description': 'Tab 或边界方向键切换单元格，Escape 返回正文；多行内容和管线请在源码模式编辑。' }),
        EditorView.lineWrapping,
        keymap.of([
          { key: 'ArrowLeft', run: arrow('left') }, { key: 'ArrowRight', run: arrow('right') },
          { key: 'ArrowUp', run: arrow('up') }, { key: 'ArrowDown', run: arrow('down') },
          { key: 'Tab', run: () => navigate(false) }, { key: 'Shift-Tab', run: () => navigate(true) },
          { key: 'Enter', run: () => navigate(false) },
          { key: 'Escape', run: view => {
            if (view.composing || view.compositionStarted || active?.composing) return false
            const position = widget.rows.at(-1)!.at(-1)!.to
            close(); outer.dispatch({ selection: { anchor: Math.min(outer.state.doc.length, outer.state.doc.lineAt(position).to + 1) } }); outer.focus(); return true
          } },
          { key: 'Mod-z', run: () => { undo(outer); queueMicrotask(() => { if (outer.dom.isConnected) outer.focus() }); return true } },
          { key: 'Mod-Shift-z', run: () => { redo(outer); queueMicrotask(() => { if (outer.dom.isConnected) outer.focus() }); return true } },
          { key: 'Mod-y', run: () => { redo(outer); queueMicrotask(() => { if (outer.dom.isConnected) outer.focus() }); return true } },
          { key: 'Mod-End', run: () => { close(); outer.dispatch({ selection: { anchor: outer.state.doc.length } }); outer.focus(); return true } },
          { key: 'Mod-Home', run: () => { close(); outer.dispatch({ selection: { anchor: 0 } }); outer.focus(); return true } },
          ...defaultKeymap,
        ]),
        EditorState.transactionFilter.of(transaction => {
          if (syncing || !transaction.docChanged) return transaction
          if (!active || !writable() || active.doc !== outer.state.doc) { report('正文或文件状态已变化，未写入旧单元格；请重新选择单元格。'); return [] }
          const result = tableCellTransaction(outer.state, active.from, active.to, transaction.newDoc.toString())
          if ('error' in result) { report(result.error); return [] }
          return transaction
        }),
        EditorView.updateListener.of(update => {
          if (syncing || !update.docChanged || !active) return
          const current = active, value = update.state.doc.toString()
          const result = tableCellTransaction(outer.state, current.from, current.to, value)
          if ('error' in result) { report(result.error); return }
          current.writing = true
          try {
            outer.dispatch(result)
            if (outer.state.sliceDoc(current.from, current.from + value.length) !== value) {
              report('单元格事务未应用，原文已保留，请核对源码。')
              queueMicrotask(() => {
                if (destroyed || active !== current) return
                syncing = true
                try { current.view.dispatch({ changes: { from: 0, to: current.view.state.doc.length, insert: outer.state.sliceDoc(current.from, current.to) } }) }
                finally { syncing = false }
              })
              return
            }
            current.to = current.from + value.length; current.doc = outer.state.doc
          } finally { current.writing = false }
          outer.requestMeasure()
        }),
        EditorView.domEventHandlers({
          compositionstart: (_event, view) => { if (active) active.composing = true; widget.options.onCellComposition?.(true, view) },
          compositionend: (_event, view) => { if (active) active.composing = false; widget.options.onCellComposition?.(false, view) },
          blur: (_event, view) => { if (active?.composing) { active.composing = false; widget.options.onCellComposition?.(false, view, true) } },
          paste: event => {
            if (event.clipboardData?.files.length || (!event.clipboardData?.getData('text/plain') && event.clipboardData?.getData('text/html'))) { event.preventDefault(); report('单元格只接受纯文本，附件或 HTML 请在正文中处理。'); return true }
            return false
          },
          drop: event => { event.preventDefault(); report('单元格暂不支持拖放，请使用纯文本粘贴或源码编辑。'); return true },
        }),
      ] }) })
      active = { view: input, row, column, from: cell.from, to: cell.to, doc: outer.state.doc, writing: false, composing: false }
      input.focus(); outer.requestMeasure()
    }
    const render = () => {
      table.replaceChildren(); cells.length = 0
      for (const [row, values] of widget.rows.entries()) {
        const tr = document.createElement('tr'), elements: HTMLElement[] = []
        for (const [column, cell] of values.entries()) {
          const td = document.createElement(row === 0 ? 'th' : 'td')
          td.textContent = cell.text; td.tabIndex = 0
          td.setAttribute('aria-label', cell.text || `${row === 0 ? '表头' : `第 ${row} 行`}，第 ${column + 1} 列，空单元格`)
          td.style.textAlign = widget.alignments[column] === 'none' ? 'left' : widget.alignments[column] ?? 'left'
          td.addEventListener('mousedown', event => { if (!td.classList.contains('folio-table-active')) event.preventDefault() })
          td.addEventListener('click', () => { if (!td.classList.contains('folio-table-active')) activate(row, column) })
          td.addEventListener('keydown', event => { if (event.target === td && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); activate(row, column) } })
          tr.append(td); elements.push(td)
        }
        table.append(tr); cells.push(elements)
      }
    }
    render(); root.append(controlsHost, table)
    root.addEventListener('folio-table-focus', focusSelection)
    lives.set(root, {
      update: next => {
        const shapeChanged = widget.rows.length !== next.rows.length || widget.rows[0].length !== next.rows[0].length
        widget = next
        if (shapeChanged) { close(); render(); return }
        for (const [row, values] of widget.rows.entries()) for (const [column, cell] of values.entries()) {
          const td = cells[row][column]
          td.setAttribute('aria-label', cell.text || `${row === 0 ? '表头' : `第 ${row} 行`}，第 ${column + 1} 列，空单元格`)
          td.style.textAlign = widget.alignments[column] === 'none' ? 'left' : widget.alignments[column] ?? 'left'
          if (active?.row === row && active.column === column) {
            if (!active.writing && active.doc !== outer.state.doc) {
              const current = active
              if (current.composing) { report('正文在输入法候选期间变化，请核对草稿。'); close(); return }
              current.from = cell.from; current.to = cell.to; current.doc = outer.state.doc
              if (current.view.state.doc.toString() === cell.text) continue
              // 外层撤销/重做才同步回当前单元格；同步本身不得再次写原文。
              const view = current.view; syncing = true
              try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: cell.text }, selection: { anchor: 0, head: cell.text.length } }) }
              finally { syncing = false }
            }
          } else td.textContent = cell.text
        }
      },
      destroy: () => { destroyed = true; close(); queueMicrotask(() => controls.unmount()) },
    })
    return root
  }
  updateDOM(dom: HTMLElement, _view: EditorView, previous: TableWidget) {
    if (this.options !== previous.options) return false
    const life = lives.get(dom)
    if (!life) return false
    life.update(this); return true
  }
  destroy(dom: HTMLElement) { lives.get(dom)?.destroy(); lives.delete(dom) }
}
