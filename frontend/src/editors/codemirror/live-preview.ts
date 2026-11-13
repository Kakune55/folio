import { syntaxTree } from '@codemirror/language'
import { EditorState, type Extension, type Range, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { markdownLinkTarget, markdownReferences } from './links'
import { AlertTitle, githubAlert } from './github-alerts'
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

class HorizontalRule extends WidgetType {
  eq(other: WidgetType) { return other instanceof HorizontalRule }
  ignoreEvent() { return false }
  toDOM() {
    const line = document.createElement('span')
    line.className = 'folio-md-rule'
    line.setAttribute('role', 'separator')
    line.setAttribute('aria-label', '分割线')
    return line
  }
}

class EntityText extends WidgetType {
  readonly source: string
  constructor(source: string) { super(); this.source = source }
  eq(other: EntityText) { return this.source === other.source }
  ignoreEvent() { return false }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'folio-md-entity'
    // 输入限定为单个实体，不接受标签；解码结果只通过 textContent 显示。
    if (/^&(?:#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]+);$/i.test(this.source)) {
      // 属性上下文不会把未知 &notreal; 按无分号的 &not 前缀部分解码。
      const text = document.createElement('template')
      text.innerHTML = `<span data-value="${this.source}"></span>`
      span.textContent = text.content.firstElementChild?.getAttribute('data-value') ?? this.source
    } else span.textContent = this.source
    return span
  }
}

const inlineClasses: Record<string, string> = {
  Emphasis: 'emphasis', StrongEmphasis: 'strong', InlineCode: 'inline-code', Strikethrough: 'strike', Link: 'link',
}

/** 仅消费已经解析的可见源码，不推动全篇解析，也不修改正文。 */
export function livePreviewDecorations(state: EditorState, visible: readonly SourceRange[], options: PreviewOptions = {}): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const seen = new Set<string>()
  const alertHeaders: SourceRange[] = []
  const tree = syntaxTree(state)
  let references: ReadonlyMap<string, string> | undefined
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
    if (alertHeaders.some(header => node.from >= header.from && node.to <= header.to)) return false
    if (name === 'InlineMath' || name === 'MathBlock') return false
    if (['Image', 'Table', 'HTMLBlock', 'HTMLTag'].includes(name)) return false
    if (name === 'FencedCode' || name === 'CodeBlock') {
      lines(node, 'code-line', viewport)
      return false
    }
    if (name === 'Blockquote') {
      const alert = githubAlert(state, node)
      if (alert) {
        lines(node, 'alert-line', viewport); lines(node, `alert-${alert.type.toLowerCase()}`, viewport)
        lines({ from: node.from, to: node.from }, 'alert-start', viewport)
        lines({ from: node.to, to: node.to }, 'alert-end', viewport)
        alertHeaders.push(alert)
        const key = `${alert.from}:alert-title`
        if (!active(node) && !seen.has(key)) { seen.add(key); add(Decoration.replace({ widget: new AlertTitle(alert.type) }), alert.from, alert.to) }
      } else lines(node, 'quote-line', viewport)
    }
    if (name === 'ListItem') lines(node, 'list-line', viewport)
    if (name === 'HorizontalRule' && !active(node)) {
      lines(node, 'rule-line', viewport)
      add(Decoration.replace({ widget: new HorizontalRule() }), node.from, node.to)
      return false
    }
    const heading = /^(ATX|Setext)Heading([1-6])$/.exec(name)
    if (heading) {
      const underline = heading[1] === 'Setext' ? node.getChildren('HeaderMark').at(-1) : undefined
      lines(underline ? { from: node.from, to: Math.max(node.from, state.doc.lineAt(underline.from).from - 1) } : node, `heading-${heading[2]}`, viewport)
    }
    const key = `${node.from}:${node.to}:${name}`
    if (seen.has(key)) return true
    seen.add(key)
    const bareURL = name === 'URL' && !['Link', 'Image', 'Autolink', 'LinkReference'].includes(node.parent?.name ?? '')
    if (['LinkReference', 'LinkLabel', 'LinkTitle'].includes(name) || name === 'URL' && !bareURL) return false
    let inlineClass = inlineClasses[name]
    if (name === 'Link') {
      references ??= markdownReferences(state)
      if (markdownLinkTarget(state, node, references) === undefined) inlineClass = ''
    } else if (name === 'Autolink' || bareURL) inlineClass = 'link'
    if (inlineClass) add(Decoration.mark({ class: `folio-md-${inlineClass}` }), node.from, node.to)
    if (!active(node)) {
      if (name === 'Escape') hide(node.from, node.from + 1)
      if (name === 'HardBreak') hide(node.from, Math.min(node.to, state.doc.lineAt(node.from).to))
      if (name === 'Entity') add(Decoration.replace({ widget: new EntityText(state.sliceDoc(node.from, node.to)) }), node.from, node.to)
      if (name === 'Autolink') for (const mark of node.getChildren('LinkMark')) hide(mark.from, mark.to)
    }
    if (name === 'TaskMarker' && !active(node)) {
      const disabled = state.readOnly || !state.facet(EditorView.editable) || options.canEdit?.() === false
      add(Decoration.replace({ widget: new TaskCheckbox(state.sliceDoc(node.from + 1, node.from + 2) !== ' ', options, disabled) }), node.from, node.to)
    }
    if (['HeaderMark', 'QuoteMark', 'ListMark'].includes(name) && node.parent && !active(node.parent)) {
      const atx = name === 'HeaderMark' && /^ATXHeading[1-6]$/.test(node.parent.name)
      let end = node.to
      if (atx && node.from === node.parent.from) {
        const line = state.doc.lineAt(node.to)
        end += /^[ \t]*/.exec(line.text.slice(node.to - line.from))![0].length
      }
      // 标题收起标记及分隔空白；引用和列表仍保留容器缩进槽位。
      hide(node.from, end, !atx)
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
