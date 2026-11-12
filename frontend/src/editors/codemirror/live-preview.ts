import { syntaxTree } from '@codemirror/language'
import { EditorState, type Extension, type Range, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import './live-preview.css'

type PreviewOptions = { canEdit?: () => boolean; onBlocked?: (message: string) => void }
type SourceRange = { from: number; to: number }

/** 只修改任务框中间的一个字符，不规范化列表或空白。 */
export function taskCheckboxTransaction(state: EditorState, from: number, options: PreviewOptions = {}): TransactionSpec | null {
  if (state.readOnly || !state.facet(EditorView.editable) || options.canEdit?.() === false) {
    options.onBlocked?.('当前文档不可编辑，任务状态未修改。')
    return null
  }
  if (from < 0 || from + 3 > state.doc.length) return null
  const node = syntaxTree(state).resolveInner(from + 1, -1)
  if (node.name !== 'TaskMarker' || node.from !== from || node.to !== from + 3) return null
  const text = state.sliceDoc(from, from + 3)
  if (!/^\[[ xX]\]$/.test(text)) return null
  return { changes: { from: from + 1, to: from + 2, insert: text[1] === ' ' ? 'x' : ' ' }, userEvent: 'input.task' }
}

class TaskCheckbox extends WidgetType {
  readonly checked: boolean
  readonly options: PreviewOptions
  readonly disabled: boolean
  constructor(checked: boolean, options: PreviewOptions, disabled: boolean) {
    super()
    this.checked = checked
    this.options = options
    this.disabled = disabled
  }
  eq(other: TaskCheckbox) { return this.checked === other.checked && this.options === other.options && this.disabled === other.disabled }
  toDOM(view: EditorView) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'folio-md-task'
    button.setAttribute('role', 'checkbox')
    button.setAttribute('aria-checked', String(this.checked))
    button.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为已完成')
    button.setAttribute('aria-disabled', String(this.disabled))
    button.addEventListener('pointerdown', event => event.preventDefault())
    button.addEventListener('mousedown', event => event.preventDefault())
    button.addEventListener('click', event => {
      event.preventDefault()
      const transaction = taskCheckboxTransaction(view.state, view.posAtDOM(button), this.options)
      if (transaction) view.dispatch(transaction)
    })
    return button
  }
}

const inlineClasses: Record<string, string> = {
  Emphasis: 'emphasis', StrongEmphasis: 'strong', InlineCode: 'inline-code', Strikethrough: 'strike', Link: 'link',
}

/** 仅消费已经解析的可见源码，不推动全篇解析，也不修改正文。 */
export function livePreviewDecorations(state: EditorState, visible: readonly SourceRange[], options: PreviewOptions = {}): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const seen = new Set<string>()
  const tree = syntaxTree(state)
  let budget = 6000
  const deadline = performance.now() + 12
  const add = (decoration: Decoration, from: number, to = from) => {
    if (from < 0 || to < from || to > state.doc.length) return
    if (!visible.some(viewport => from <= viewport.to && to >= viewport.from)) return
    ranges.push(decoration.range(from, to))
  }
  const active = (node: SourceRange) => {
    const from = state.doc.lineAt(node.from).from
    const to = state.doc.lineAt(node.to).to
    return state.selection.ranges.some(range => range.empty
      ? range.from >= from && range.from <= to
      : range.from <= to && range.to >= from)
  }
  const hide = (from: number, to: number, slot = false) => {
    // ViewPlugin 不能用替换装饰吞掉换行；跨行语法保留原标记。
    if (from < to && state.doc.lineAt(from).number === state.doc.lineAt(to).number) {
      add(slot ? Decoration.mark({ class: 'folio-md-marker-slot' }) : Decoration.replace({}), from, to)
    }
  }
  const lines = (node: SourceRange, className: string, viewport: SourceRange) => {
    let line = state.doc.lineAt(Math.max(node.from, viewport.from))
    const end = Math.min(node.to, viewport.to)
    while (line.from <= end && budget-- > 0 && performance.now() <= deadline) {
      const key = `${line.from}:${className}`
      if (!seen.has(key)) {
        seen.add(key)
        add(Decoration.line({ class: `folio-md-${className}` }), line.from)
      }
      if (line.to >= state.doc.length) break
      line = state.doc.lineAt(line.to + 1)
    }
  }
  const visit = (node: SyntaxNode, viewport: SourceRange): boolean => {
    const name = node.name
    if (['Image', 'Table', 'HTMLBlock', 'HTMLTag'].includes(name)) return false
    if (name === 'FencedCode' || name === 'CodeBlock') {
      lines(node, 'code-line', viewport)
      return false
    }
    if (name === 'Blockquote') lines(node, 'quote-line', viewport)
    if (name === 'ListItem') lines(node, 'list-line', viewport)
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name)
    if (heading) lines(node, `heading-${heading[1]}`, viewport)
    const key = `${node.from}:${node.to}:${name}`
    if (seen.has(key)) return true
    seen.add(key)
    const inlineClass = inlineClasses[name]
    if (inlineClass) add(Decoration.mark({ class: `folio-md-${inlineClass}` }), node.from, node.to)
    if (name === 'TaskMarker' && !active(node)) {
      const disabled = state.readOnly || !state.facet(EditorView.editable) || options.canEdit?.() === false
      add(Decoration.replace({ widget: new TaskCheckbox(state.sliceDoc(node.from + 1, node.from + 2) !== ' ', options, disabled) }), node.from, node.to)
    }
    if (['HeaderMark', 'QuoteMark', 'ListMark'].includes(name) && node.parent && !active(node.parent)) {
      // 保留前缀槽位，让活动状态切换不改变缩进与文字命中位置。
      hide(node.from, node.to, true)
      if (name === 'ListMark') {
        add(Decoration.mark({ class: node.parent.parent?.name === 'OrderedList' ? 'folio-md-ordered-marker' : 'folio-md-list-marker' }), node.from, node.to)
      }
    }
    if (inlineClass && !active(node)) {
      if (name === 'Link') {
        const children: SyntaxNode[] = []
        for (let child = node.firstChild; child && budget-- > 0 && performance.now() <= deadline; child = child.nextSibling) children.push(child)
        const open = children[0]
        const close = children.find(child => child.name === 'LinkMark' && state.sliceDoc(child.from, child.to) === ']')
        if (open?.name === 'LinkMark' && state.sliceDoc(open.from, open.to) === '[' && close) {
          hide(open.from, open.to)
          hide(close.from, node.to)
        }
      } else {
        for (let child = node.firstChild; child && budget-- > 0 && performance.now() <= deadline; child = child.nextSibling) {
          if (['EmphasisMark', 'CodeMark', 'StrikethroughMark'].includes(child.name)) hide(child.from, child.to)
        }
      }
    }
    return true
  }
  for (const viewport of visible) {
    if (viewport.from < 0 || viewport.to > state.doc.length || viewport.to < viewport.from) continue
    const cursor = tree.cursor()
    // 手动遍历使预算耗尽可以立即停止，而非继续访问巨型节点的所有兄弟。
    for (;;) {
      if (--budget < 0 || performance.now() > deadline) break
      let descend = cursor.to >= viewport.from && cursor.from <= viewport.to
      if (descend) descend = visit(cursor.node, viewport)
      if (descend && cursor.firstChild()) continue
      let next = cursor.nextSibling()
      while (!next && cursor.parent()) next = cursor.nextSibling()
      if (!next || cursor.from > viewport.to) break
    }
  }
  return Decoration.set(ranges, true)
}

export function markdownLivePreview(options: PreviewOptions = {}): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet
    pointerFrozen = false
    compositionFrozen = false
    frame = 0
    readonly view: EditorView
    constructor(view: EditorView) {
      this.view = view
      this.decorations = livePreviewDecorations(view.state, view.visibleRanges, options)
      view.dom.ownerDocument.addEventListener('pointerup', this.release)
      view.dom.ownerDocument.addEventListener('pointercancel', this.release)
    }
    release = () => {
      if (!this.pointerFrozen) return
      this.pointerFrozen = false
      this.refresh()
    }
    refresh = () => {
      if (this.frame) return
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        if (!this.pointerFrozen && !this.compositionFrozen && !this.view.compositionStarted && !this.view.composing) {
          this.view.dispatch({})
        }
      })
    }
    update(update: ViewUpdate) {
      if (this.pointerFrozen || this.compositionFrozen || update.view.compositionStarted || update.view.composing) {
        if (update.docChanged) this.decorations = this.decorations.map(update.changes)
        return
      }
      this.decorations = livePreviewDecorations(update.state, update.view.visibleRanges, options)
    }
    destroy() {
      cancelAnimationFrame(this.frame)
      this.view.dom.ownerDocument.removeEventListener('pointerup', this.release)
      this.view.dom.ownerDocument.removeEventListener('pointercancel', this.release)
    }
  }, {
    decorations: plugin => plugin.decorations,
    eventHandlers: {
      pointerdown() { this.pointerFrozen = true },
      compositionstart() { this.compositionFrozen = true },
      compositionend() { this.compositionFrozen = false; this.refresh() },
      blur() { this.pointerFrozen = false; this.refresh() },
    },
  })
}
