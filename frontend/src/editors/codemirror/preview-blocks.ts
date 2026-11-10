import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { EditorBridge } from '../bridge'
import { createMermaidPreview } from '../mermaid-preview'
import './preview-blocks.css'

type Options = { bridge?: EditorBridge; canEdit?: () => boolean; onBlocked?: (message: string) => void; revealTables?: () => boolean }
type Cell = { from: number; to: number; text: string }
const composition = StateEffect.define<boolean>()
const MAX_PARSE = 100000, MAX_NODES = 4000, MAX_TABLE = 20000
const widgetLives = new WeakMap<HTMLElement, { destroy: () => void; render?: (source: string) => void }>()

class ResourceWidget extends WidgetType {
  readonly kind: 'image' | 'mermaid'
  readonly source: string
  readonly label: string
  readonly options: Options
  constructor(kind: 'image' | 'mermaid', source: string, label: string, options: Options) {
    super(); this.kind = kind; this.source = source; this.label = label; this.options = options
  }
  eq(other: ResourceWidget) { return this.kind === other.kind && this.source === other.source && this.label === other.label && this.options === other.options }
  get estimatedHeight() { return this.kind === 'mermaid' ? 180 : 160 }
  toDOM(view: EditorView) {
    const root = document.createElement('div')
    root.className = `folio-preview-${this.kind}`
    let active = true
    const measure = () => { if (active) view.requestMeasure() }
    const observer = new MutationObserver(measure)
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true })
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    resize?.observe(root)
    if (this.kind === 'mermaid') {
      const preview = createMermaidPreview(root)
      const render = (source: string) => {
        const oldImage = root.querySelector('img')
        const host = preview.render('mermaid', source)!
        if (oldImage) {
          const status = document.createElement('span')
          status.className = 'mermaid-status'; status.textContent = '图表待更新（显示上次结果）'
          host.replaceChildren(oldImage, status)
          host.dataset.state = 'pending'; host.setAttribute('aria-busy', 'true')
        }
        root.replaceChildren(host)
      }
      render(this.source)
      widgetLives.set(root, { render, destroy: () => { active = false; observer.disconnect(); resize?.disconnect(); preview.destroy() } })
    } else {
      const status = document.createElement('span')
      status.className = 'folio-preview-status'
      try {
        if (!this.options.bridge) throw new Error('图片预览需要资源桥接，源码已保留。')
        if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(this.source.trim())) throw new Error('不支持外部图片地址，源码已保留。')
        // URL 的授权与工作区边界由 bridge 处理，绝不回退到 Markdown href。
        const url = this.options.bridge.imageURL(this.source)
        if (!url) throw new Error('图片地址不可用，源码已保留。')
        const image = document.createElement('img')
        image.alt = this.label
        image.onload = measure
        image.onerror = () => { if (active) { status.textContent = '图片加载失败，源码已保留。'; measure() } }
        image.src = url
        root.append(image)
        root.addEventListener('click', event => {
          if (event.ctrlKey || event.metaKey) { event.preventDefault(); this.options.bridge?.openLink(this.source) }
        })
        widgetLives.set(root, { destroy: () => { active = false; image.onload = null; image.onerror = null; observer.disconnect(); resize?.disconnect() } })
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : '图片预览失败，源码已保留。'
      }
      root.append(status)
      if (!widgetLives.has(root)) widgetLives.set(root, { destroy: () => { active = false; observer.disconnect(); resize?.disconnect() } })
    }
    return root
  }
  updateDOM(dom: HTMLElement, _view: EditorView, previous: ResourceWidget) {
    if (this.kind !== 'mermaid' || previous.kind !== 'mermaid' || this.options !== previous.options) return false
    const life = widgetLives.get(dom)
    if (!life?.render) return false
    life.render(this.source)
    return true
  }
  destroy(dom: HTMLElement) { widgetLives.get(dom)?.destroy(); widgetLives.delete(dom) }
}

class TableWidget extends WidgetType {
  readonly rows: Cell[][]
  readonly raw: string
  readonly options: Options
  constructor(rows: Cell[][], raw: string, options: Options) { super(); this.rows = rows; this.raw = raw; this.options = options }
  eq(other: TableWidget) { return this.raw === other.raw && JSON.stringify(this.rows) === JSON.stringify(other.rows) && this.options === other.options }
  get estimatedHeight() { return this.rows.length * 38 + 16 }
  toDOM(view: EditorView) {
    const root = document.createElement('div'), table = document.createElement('table')
    root.className = 'folio-preview-table'
    for (const [index, row] of this.rows.entries()) {
      const tr = document.createElement('tr')
      for (const cell of row) {
        const td = document.createElement(index === 0 ? 'th' : 'td')
        td.textContent = cell.text
        td.tabIndex = 0
        const focus = () => {
          if (view.composing || view.compositionStarted) { this.options.onBlocked?.('请先确认或取消输入法候选，再定位表格源码。'); return }
          // 只读也允许定位源码；此处不发出 changes，不触碰正文或撤销历史。
          view.dispatch({ selection: { anchor: cell.from, head: cell.to }, scrollIntoView: true })
          view.focus()
        }
        td.addEventListener('mousedown', event => event.preventDefault())
        td.addEventListener('click', focus)
        td.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focus() } })
        tr.append(td)
      }
      table.append(tr)
    }
    root.append(table)
    return root
  }
}

function tableRows(state: EditorState, node: SyntaxNode): Cell[][] | undefined {
  if (node.to - node.from > MAX_TABLE) return
  const rows: Cell[][] = []
  let count = 0
  for (let row = node.firstChild; row; row = row.nextSibling) {
    if (row.name === 'TableDelimiter') continue
    if (row.name !== 'TableHeader' && row.name !== 'TableRow') return
    const cells: Cell[] = []
    for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
      if (cell.name === 'TableDelimiter') continue
      if (cell.name !== 'TableCell' || ++count > 500) return
      const text = state.sliceDoc(cell.from, cell.to)
      // 首版仅预览可直接映射的纯文本，复杂行内结构继续显示源码。
      if (cell.firstChild || /[\\`*_[\]<>!&]/.test(text)) return
      cells.push({ from: cell.from, to: cell.to, text })
    }
    if (!cells.length || (rows.length && cells.length !== rows[0].length)) return
    rows.push(cells)
  }
  return rows.length ? rows : undefined
}

function blocks(state: EditorState, options: Options): DecorationSet {
  const upto = Math.min(state.doc.length, MAX_PARSE)
  const tree = ensureSyntaxTree(state, upto, 5) ?? syntaxTree(state)
  const ranges: Range<Decoration>[] = []
  let count = 0
  tree.iterate({ to: upto, enter(ref) {
    if (++count > MAX_NODES || (ref.name !== 'Document' && ref.to > upto)) return false
    const node = ref.node
    if (node.name === 'Table') {
      if (node.parent?.name !== 'Document') return false
      if (options.revealTables?.()) return false
      const selected = state.selection.ranges.some(range => range.from <= node.to && range.to >= node.from)
      if (!selected) {
        const rows = tableRows(state, node)
        if (rows) ranges.push(Decoration.replace({ block: true, widget: new TableWidget(rows, state.sliceDoc(node.from, node.to), options) }).range(node.from, node.to))
      }
      return false
    }
    if (node.name === 'FencedCode') {
      if (node.parent?.name !== 'Document') return false
      const language = node.getChild('CodeInfo'), code = node.getChild('CodeText')
      if (language && state.sliceDoc(language.from, language.to).trim().toLowerCase() === 'mermaid') {
        ranges.push(Decoration.widget({ block: true, side: 1, widget: new ResourceWidget('mermaid', code ? state.sliceDoc(code.from, code.to) : '', '', options) }).range(state.doc.lineAt(node.to).to))
      }
      return false
    }
    if (node.name === 'Image') {
      const url = node.getChild('URL')
      if (url) {
        const closing = node.getChildren('LinkMark').find(mark => state.sliceDoc(mark.from, mark.to) === ']')
        const alt = state.sliceDoc(node.from + 2, closing?.from ?? node.from + 2).replace(/\\([\\[\]])/g, '$1')
        ranges.push(Decoration.widget({ block: true, side: 1, widget: new ResourceWidget('image', state.sliceDoc(url.from, url.to).replace(/^<(.*)>$/, '$1'), alt, options) }).range(state.doc.lineAt(node.to).to))
      }
      return false
    }
  } })
  return Decoration.set(ranges, true)
}

export function markdownPreviewBlocks(options: Options): Extension {
  const field = StateField.define<{ decorations: DecorationSet; composing: boolean }>({
    create: state => ({ decorations: blocks(state, options), composing: false }),
    update(value, transaction) {
      let composing = value.composing
      for (const effect of transaction.effects) if (effect.is(composition)) composing = effect.value
      if (composing) return { composing, decorations: value.decorations.map(transaction.changes) }
      if (transaction.docChanged || transaction.selection || transaction.effects.length || composing !== value.composing || syntaxTree(transaction.state) !== syntaxTree(transaction.startState)) return { composing, decorations: blocks(transaction.state, options) }
      return value
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  })
  return [field, EditorView.domEventHandlers({
    compositionstart: (_event, view) => { view.dispatch({ effects: composition.of(true) }) },
    compositionend: (_event, view) => { view.dispatch({ effects: composition.of(false) }) },
  })]
}
