import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { codeLanguage } from './code-languages'
import './code-blocks.css'

type Options = { slice: (state: EditorState, from: number, to: number) => string; onBlocked?: (message: string) => void }
const composition = StateEffect.define<boolean>()
const cleanups = new WeakMap<HTMLElement, () => void>()

function codeAt(state: EditorState, position: number, complete = false): SyntaxNode | undefined {
  const line = state.doc.lineAt(Math.max(0, Math.min(position, state.doc.length)))
  const tree = complete ? ensureSyntaxTree(state, state.doc.length, 30) : syntaxTree(state)
  if (!tree) return
  let found: SyntaxNode | undefined
  tree.iterate({ from: line.from, to: line.to, enter(node) {
    if (node.name === 'FencedCode' && state.doc.lineAt(node.from).from === line.from) { found = node.node; return false }
  } })
  if (found && (found.getChildren('CodeMark').length > 1 || tree.length === state.doc.length)) return found
  if (!complete) return codeAt(state, position, true)
}

// CodeText 排除了引用／列表的外层前缀；逐行复制并保留代码自身空白和原始换行。
export function fencedCodeText(state: EditorState, node: SyntaxNode, slice: Options['slice']): string {
  const marks = node.getChildren('CodeMark'), texts = node.getChildren('CodeText')
  if (!marks.length) return ''
  const opening = state.doc.lineAt(marks[0].from)
  const end = marks.length > 1 ? state.doc.lineAt(marks.at(-1)!.from).from : node.to
  const pieces: string[] = []
  for (let number = opening.number + 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number)
    if (line.from >= end) break
    for (const text of texts) {
      const from = Math.max(text.from, line.from), to = Math.min(text.to, line.to, end)
      if (from < to) pieces.push(slice(state, from, to))
    }
    if (line.to < end) pieces.push(slice(state, line.to, line.to + 1))
  }
  return pieces.join('')
}

class CodeTools extends WidgetType {
  readonly info: string
  readonly options: Options
  constructor(info: string, options: Options) { super(); this.info = info; this.options = options }
  eq(other: CodeTools) { return this.info === other.info && this.options === other.options }
  toDOM(view: EditorView) {
    const language = codeLanguage(this.info), root = document.createElement('span'), label = document.createElement('span'), button = document.createElement('button'), feedback = document.createElement('span')
    root.className = 'folio-code-tools'; root.dataset.language = language.name || 'text'
    root.setAttribute('role', 'group'); root.setAttribute('aria-label', `代码块工具 ${language.label.slice(0, 64)}`)
    label.className = 'folio-code-language'; label.textContent = language.label.slice(0, 64)
    label.title = language.description ? `围栏语言：${language.name}（${language.description.name}）` : language.name ? `暂未提供 ${language.name.slice(0, 128)} 的语法高亮，按纯文本显示` : '未指定语言，按纯文本显示'
    button.type = 'button'; button.textContent = '复制'; button.setAttribute('aria-label', '复制代码')
    feedback.className = 'visually-hidden'; feedback.setAttribute('role', 'status')
    root.append(label, button, feedback)
    root.addEventListener('mousedown', event => event.preventDefault())
    let timer: ReturnType<typeof setTimeout> | undefined
    cleanups.set(root, () => clearTimeout(timer))
    button.addEventListener('click', async event => {
      event.preventDefault()
      if (view.composing || view.compositionStarted) { this.options.onBlocked?.('请先确认输入法候选，再复制代码。'); return }
      const state = view.state, doc = state.doc
      const node = codeAt(state, view.posAtDOM(button))
      if (!node) { this.options.onBlocked?.('代码块仍在解析或已变化，未复制片段；请稍后重试。'); return }
      let text: string
      try { text = fencedCodeText(state, node, this.options.slice) }
      catch (error) {
        feedback.textContent = '代码范围或原始换行核对失败，未复制。'
        this.options.onBlocked?.(error instanceof Error ? error.message : feedback.textContent)
        return
      }
      if (!text) { feedback.textContent = '代码块为空，没有可复制的内容。'; return }
      button.disabled = true
      try {
        await navigator.clipboard.writeText(text)
        if (!root.isConnected || view.state.doc !== doc) return
        button.textContent = '已复制'; feedback.textContent = '代码已复制。'
      } catch {
        if (!root.isConnected || view.state.doc !== doc) return
        button.textContent = '失败'; feedback.textContent = '复制失败，请使用源码手动复制。'
        this.options.onBlocked?.('无法写入剪贴板，正文未改动；请在源码中选择代码手动复制。')
      } finally {
        button.disabled = false
        clearTimeout(timer)
        if (root.isConnected) timer = setTimeout(() => { button.textContent = '复制' }, 1600)
      }
    })
    return root
  }
  destroy(dom: HTMLElement) { cleanups.get(dom)?.(); cleanups.delete(dom) }
}

function controls(state: EditorState, options: Options): DecorationSet {
  const ranges: Range<Decoration>[] = [], cursor = syntaxTree(state).cursor()
  let budget = 6000
  for (;;) {
    if (--budget < 0) break
    let descend = ['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'].includes(cursor.name)
    if (cursor.name === 'FencedCode') {
      const node = cursor.node, info = node.getChild('CodeInfo'), from = state.doc.lineAt(node.from).from
      ranges.push(Decoration.line({ class: 'folio-code-opening' }).range(from))
      ranges.push(Decoration.widget({ widget: new CodeTools(info ? state.sliceDoc(info.from, info.to) : '', options), side: -1 }).range(from))
      descend = false
    }
    if (descend && cursor.firstChild()) continue
    let next = cursor.nextSibling()
    while (!next && cursor.parent()) next = cursor.nextSibling()
    if (!next) break
  }
  return Decoration.set(ranges, true)
}

export function codeBlockControls(options: Options): Extension {
  const field = StateField.define<{ decorations: DecorationSet; composing: boolean }>({
    create: state => ({ decorations: controls(state, options), composing: false }),
    update(value, transaction) {
      let composing = value.composing
      for (const effect of transaction.effects) if (effect.is(composition)) composing = effect.value
      if (composing) return { composing, decorations: value.decorations.map(transaction.changes) }
      if (transaction.docChanged || transaction.effects.length || composing !== value.composing || syntaxTree(transaction.state) !== syntaxTree(transaction.startState)) return { composing, decorations: controls(transaction.state, options) }
      return value
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  })
  return [field, EditorView.domEventHandlers({ compositionstart: (_event, view) => { view.dispatch({ effects: composition.of(true) }) }, compositionend: (_event, view) => { view.dispatch({ effects: composition.of(false) }) } })]
}
