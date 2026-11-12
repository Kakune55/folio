import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { EditorBridge } from '../bridge'
import { createMermaidCache, createMermaidPreview, type MermaidCache } from '../mermaid-preview'
import { tableAlignments, tableContext, tableSourceRows } from './tables'
import { TableWidget, type TableWidgetOptions } from './table-widget'
import { decodeMarkdownTarget } from './links'
import './preview-blocks.css'

type Options = TableWidgetOptions & { bridge?: EditorBridge; revealTables?: () => boolean; mermaidCache?: MermaidCache }
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
      const preview = createMermaidPreview(root, this.options.mermaidCache)
      const render = (source: string) => {
        const oldImage = root.querySelector('img')
        const host = preview.render('mermaid', source)!
        if (oldImage && host.dataset.state !== 'ready') {
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

function tableRows(state: EditorState, node: SyntaxNode): Cell[][] | undefined {
  if (node.to - node.from > MAX_TABLE) return
  const rows = tableSourceRows(state, node.from)
  // 单元格显示原文字面量，不执行 HTML，也不把行内 Markdown 重序列化。
  return rows
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
      const rows = tableRows(state, node)
      const selected = state.selection.ranges.some(range => !range.empty && range.from <= node.to && range.to >= node.from && !(state.selection.ranges.length === 1 && tableContext(state)))
      if (rows && !selected) ranges.push(Decoration.replace({ block: true, widget: new TableWidget(rows, state.sliceDoc(node.from, node.to), options, tableAlignments(state, node.from) ?? [], state.doc) }).range(node.from, node.to))
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
        ranges.push(Decoration.widget({ block: true, side: 1, widget: new ResourceWidget('image', decodeMarkdownTarget(state.sliceDoc(url.from, url.to)), alt, options) }).range(state.doc.lineAt(node.to).to))
      }
      return false
    }
  } })
  return Decoration.set(ranges, true)
}

export function markdownPreviewBlocks(options: Options): Extension {
  const previewOptions = { ...options, mermaidCache: options.mermaidCache ?? createMermaidCache() }
  const field = StateField.define<{ decorations: DecorationSet; composing: boolean }>({
    create: state => ({ decorations: blocks(state, previewOptions), composing: false }),
    update(value, transaction) {
      let composing = value.composing
      for (const effect of transaction.effects) if (effect.is(composition)) composing = effect.value
      if (composing) return { composing, decorations: value.decorations.map(transaction.changes) }
      if (transaction.docChanged || transaction.selection || transaction.effects.length || composing !== value.composing || syntaxTree(transaction.state) !== syntaxTree(transaction.startState)) return { composing, decorations: blocks(transaction.state, previewOptions) }
      return value
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  })
  return [field, EditorView.domEventHandlers({
    compositionstart: (_event, view) => { view.dispatch({ effects: composition.of(true) }) },
    compositionend: (_event, view) => { view.dispatch({ effects: composition.of(false) }) },
  })]
}
