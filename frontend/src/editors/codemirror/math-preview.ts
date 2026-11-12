import { syntaxTree } from '@codemirror/language'
import { EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import 'katex/dist/katex.min.css'
import './math-preview.css'

let katex: Promise<typeof import('katex')> | undefined
const loadKatex = () => katex ??= import('katex').catch(error => { katex = undefined; throw error })
const composition = StateEffect.define<boolean>()
type MathOptions = { revealSource?: () => boolean; canReveal?: () => boolean; onBlocked?: (message: string) => void }

/** 成功结果仅缓存在当前预览中；每个公式使用独立宏环境。 */
export function createMathRenderer() {
  const cache = new Map<string, string>()
  let bytes = 0
  return {
    render(source: string, display: boolean): string | Promise<string> {
      if (!source.trim()) throw new Error('公式内容为空，请编辑源码。')
      if (source.length > (display ? 20000 : 4000)) throw new Error('公式超过预览长度限制，请缩短后重试。')
      if (/\\(?:href|url|includegraphics|htmlClass|htmlId|htmlStyle|htmlData|require)\b/.test(source)) throw new Error('公式不支持外部链接、图片或 HTML 命令，请移除后重试。')
      const key = `${display ? 'block' : 'inline'}\0${source}`, cached = cache.get(key)
      if (cached !== undefined) { cache.delete(key); cache.set(key, cached); return cached }
      return loadKatex().then(module => {
        const cached = cache.get(key)
        if (cached !== undefined) return cached
        const html = module.renderToString(source, { displayMode: display, output: 'htmlAndMathml', throwOnError: true, strict: 'error', trust: false, maxExpand: 1000, maxSize: 10, globalGroup: false, macros: {} })
        if (html.length > 256000) throw new Error('公式渲染结果过大，请简化后重试。')
        const size = (key.length + html.length) * 2
        if (size <= 1024 * 1024) {
          cache.set(key, html); bytes += size
          while (cache.size > 64 || bytes > 1024 * 1024) {
            const oldest = cache.keys().next().value!
            bytes -= (oldest.length + cache.get(oldest)!.length) * 2; cache.delete(oldest)
          }
        }
        return html
      })
    },
  }
}
type MathRenderer = ReturnType<typeof createMathRenderer>
const lives = new WeakMap<HTMLElement, () => void>()

class MathWidget extends WidgetType {
  readonly from: number
  readonly to: number
  readonly anchor: number
  readonly source: string
  readonly display: boolean
  readonly renderer: MathRenderer
  readonly options: MathOptions
  constructor(from: number, to: number, anchor: number, source: string, display: boolean, renderer: MathRenderer, options: MathOptions) {
    super(); this.from = from; this.to = to; this.anchor = anchor; this.source = source; this.display = display; this.renderer = renderer; this.options = options
  }
  eq(other: MathWidget) { return this.from === other.from && this.to === other.to && this.anchor === other.anchor && this.source === other.source && this.display === other.display && this.renderer === other.renderer && this.options === other.options }
  get estimatedHeight() { return this.display ? 90 : -1 }
  toDOM(view: EditorView) {
    const root: HTMLElement = document.createElement(this.display ? 'div' : 'span')
    root.className = `folio-math-preview${this.display ? ' folio-math-display' : ''}`
    root.setAttribute('role', 'group'); root.setAttribute('aria-label', this.display ? '独立数学公式' : '行内数学公式')
    root.setAttribute('aria-description', '点击或按 Enter 编辑公式源码。'); root.tabIndex = 0
    let active = true
    const edit = () => {
      if (!active) return
      if (view.composing || view.compositionStarted || this.options.canReveal?.() === false) { this.options.onBlocked?.('请先确认或取消输入法候选，再编辑公式源码。'); return }
      if (this.to > view.state.doc.length) return
      view.dispatch({ selection: { anchor: this.anchor }, scrollIntoView: true }); view.focus()
    }
    root.addEventListener('mousedown', event => event.preventDefault())
    root.addEventListener('click', edit)
    root.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edit() } })
    const show = (html: string) => {
      if (!active) return
      // 唯一 HTML 来源是 trust:false 的 KaTeX；原始正文和错误信息从不作为 HTML 插入。
      root.innerHTML = html; root.dataset.state = 'ready'; root.setAttribute('aria-busy', 'false')
      view.requestMeasure()
    }
    const fail = (error: unknown) => {
      if (!active) return
      root.textContent = `公式渲染失败，点击编辑源码后重试：${error instanceof Error ? error.message.slice(0, 300) : '未知错误'}`
      root.dataset.state = 'error'; root.setAttribute('aria-busy', 'false'); view.requestMeasure()
    }
    lives.set(root, () => { active = false })
    try {
      const result = this.renderer.render(this.source, this.display)
      if (typeof result === 'string') show(result)
      else {
        root.textContent = '正在加载公式…'; root.dataset.state = 'pending'; root.setAttribute('aria-busy', 'true')
        void result.then(show, fail)
      }
    } catch (error) { fail(error) }
    return root
  }
  destroy(dom: HTMLElement) { lives.get(dom)?.(); lives.delete(dom) }
}

export function mathDecorations(state: EditorState, renderer: MathRenderer, options: MathOptions = {}): DecorationSet {
  const ranges: Range<Decoration>[] = []
  let count = 0
  syntaxTree(state).iterate({ to: Math.min(state.doc.length, 100000), enter(ref) {
    if (++count > 4000 || ['Table', 'FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag'].includes(ref.name)) return false
    if (ref.name !== 'InlineMath' && ref.name !== 'MathBlock') return
    const display = ref.name === 'MathBlock', node = ref.node, marks = node.getChildren('MathMark')
    if (marks.length !== 2 || node.to > 100000) return false
    const from = display ? node.from : state.doc.lineAt(node.from).from
    const to = display ? node.to : state.doc.lineAt(node.to).to
    if (state.selection.ranges.some(range => range.from <= to && range.to >= from)) return false
    const source = state.sliceDoc(marks[0].to, marks[1].from).trim()
    const anchor = marks[0].to + (display && state.sliceDoc(marks[0].to, marks[0].to + 1) === '\n' ? 1 : 0)
    ranges.push(Decoration.replace({ block: display, widget: new MathWidget(node.from, node.to, anchor, source, display, renderer, options) }).range(node.from, node.to))
    return false
  } })
  return Decoration.set(ranges, true)
}

export function markdownMathPreview(options: MathOptions = {}): Extension {
  const renderer = createMathRenderer()
  const decorate = (state: EditorState) => options.revealSource?.() ? Decoration.none : mathDecorations(state, renderer, options)
  const field = StateField.define<{ decorations: DecorationSet; composing: boolean }>({
    create: state => ({ decorations: decorate(state), composing: false }),
    update(value, transaction) {
      let composing = value.composing
      for (const effect of transaction.effects) if (effect.is(composition)) composing = effect.value
      if (composing) return { composing, decorations: value.decorations.map(transaction.changes) }
      if (transaction.docChanged || transaction.selection || transaction.effects.length || composing !== value.composing || syntaxTree(transaction.state) !== syntaxTree(transaction.startState)) return { composing, decorations: decorate(transaction.state) }
      return value
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  })
  return [field, EditorView.domEventHandlers({
    compositionstart: (_event, view) => { view.dispatch({ effects: composition.of(true) }) },
    compositionend: (_event, view) => { view.dispatch({ effects: composition.of(false) }) },
  })]
}
