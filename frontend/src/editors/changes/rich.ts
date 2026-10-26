import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core'
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Crepe } from '@milkdown/crepe'
import type { Node } from '@milkdown/kit/prose/model'
import type { ExternalUpdate } from '../../sessions/external-marks'
import { externalMarks } from '../../sessions/external-marks'
import { changeDetails, changePeek } from './details'

type ChangeState = { decorations: DecorationSet; open: number | null }
const key = new PluginKey<ChangeState>('folio-external-changes')
export function clearRichChangeMarks(editor: Crepe) {
  editor.editor.action(ctx => {
    const view = ctx.get(editorViewCtx)
    if (!view.isDestroyed && key.getState(view.state)) view.dispatch(view.state.tr.setMeta(key, 'clear').setMeta('addToHistory', false))
  })
}

export function installRichChangeMarks(editor: Crepe, update: ExternalUpdate) {
  const expired = () => update.expiresAt !== null && update.expiresAt <= Date.now()
  if (update.previousSource === undefined || expired() || (update.limited && !update.marks.length)) return
  const empty: ChangeState = { decorations: DecorationSet.empty, open: null }
  let render: ((open: number | null) => ChangeState) | undefined
  editor.editor.use($prose(() => new Plugin<ChangeState>({
    key,
    state: {
      init: () => empty,
      apply: (transaction, current) => {
        const action = transaction.getMeta(key)
        if (transaction.docChanged || action === 'clear') return empty
        if (action === 'init') return render?.(null) ?? empty
        if (typeof action === 'number') {
          const open = current.open === action ? null : action
          return open === null && expired() ? empty : render?.(open) ?? empty
        }
        if (action === 'close') return expired() ? empty : render?.(null) ?? empty
        return current
      },
    },
    props: { decorations: state => key.getState(state)?.decorations },
    view: view => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const schedule = (delay: number) => { timer = setTimeout(() => { if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, 'clear').setMeta('addToHistory', false)) }, delay) }
      if (update.expiresAt !== null) schedule(Math.max(0, update.expiresAt - Date.now()))
      return {
        update: (next, previous) => {
          const before = key.getState(previous)?.open, after = key.getState(next.state)?.open
          if (before === after) return
          clearTimeout(timer)
          if (after === null && update.expiresAt !== null && update.expiresAt > Date.now()) schedule(update.expiresAt - Date.now())
        },
        destroy: () => { clearTimeout(timer); render = undefined },
      }
    },
  })))
  // Crepe 初始化会规范化其文档；只在兼容性核对完成后绘制，避免初始化事务清掉标记。
  return () => editor.editor.action(ctx => {
    if (expired()) return
    const view = ctx.get(editorViewCtx)
    const old = ctx.get(parserCtx)(update.previousSource!)
    if (!old) return
    const semantic = (node: Node): unknown => {
      const value = node.toJSON() as { attrs?: Record<string, unknown>; content?: unknown[] }
      // 标题锚点是渲染时派生的 ID，不应把它误报为正文变更。
      if (node.type.name === 'heading' && value.attrs) delete value.attrs.id
      if (value.content) { const children: unknown[] = []; node.forEach(child => children.push(semantic(child))); value.content = children }
      return value
    }
    const blocks = (doc: Node) => { const values: string[] = []; doc.forEach(node => values.push(JSON.stringify(semantic(node)))); return values.length ? values.join('\n') + '\n' : '' }
    const before = blocks(old), after = blocks(view.state.doc)
    const marks = externalMarks(before, after).marks
    const details = changeDetails(before, after)
    const serializer = ctx.get(serializerCtx)
    const markdown = (doc: Node, from: number, to: number) => {
      if (!from || to < from) return ''
      const children: Node[] = []
      doc.forEach((node, _pos, index) => { if (index + 1 >= from && index + 1 <= to) children.push(node) })
      return children.length ? serializer(doc.type.create(null, children)) : ''
    }
    const nodes: { pos: number; size: number }[] = []
    view.state.doc.forEach((node, pos) => nodes.push({ pos, size: node.nodeSize }))
    const classes = new Map<number, string[]>()
    for (const mark of marks) {
      const index = Math.min(mark.line, nodes.length) - 1
      const value = classes.get(index) ?? []
      value.push(mark.kind === 'deleted' ? `external-rich-deleted-${mark.edge}` : `external-rich-${mark.kind}`)
      classes.set(index, value)
    }
    const doc = view.state.doc
    const base = [...classes].filter(([index]) => nodes[index]).map(([index, value]) => Decoration.node(nodes[index].pos, nodes[index].pos + nodes[index].size, { class: value.join(' '), title: '外部更新：黄色修改、绿色新增，红色三角为删除位置' }))
    const triggers = marks.flatMap(mark => {
      const detail = details.find(detail => mark.kind === 'deleted'
        ? !!detail.before && mark.line === Math.max(1, Math.min(detail.after ? detail.to + 1 : detail.from, nodes.length))
        : !!detail.after && mark.line >= detail.from && mark.line <= detail.to)
      if (!detail) return []
      const node = nodes[Math.min(mark.line, nodes.length) - 1]
      // 红三角在实际缺口命中；EOF 删除位于末块下沿，而非差异区间起点。
      const pos = node ? node.pos + (mark.kind === 'deleted' && mark.edge === 'after' ? node.size : 0) : doc.content.size
      return [{ detail, mark, pos, peekPos: node ? node.pos + node.size : doc.content.size }]
    })
    const dispatch = (action: number | 'close') => {
      if (view.isDestroyed) return
      const index = typeof action === 'number' ? action : key.getState(view.state)?.open
      view.dispatch(view.state.tr.setMeta(key, action).setMeta('addToHistory', false))
      if (index != null) {
        const button = view.dom.querySelectorAll<HTMLButtonElement>('.external-rich-change-button')[index]
        if (button) button.focus({ preventScroll: true })
        else view.focus()
      }
    }
    render = open => {
      const decorations = [...base]
      triggers.forEach(({ detail, mark, pos, peekPos }, index) => {
        const deleted = mark.kind === 'deleted'
        const options = { side: -1, stopEvent: () => true, ignoreSelection: true }
        decorations.push(Decoration.widget(pos, () => {
          const wrapper = document.createElement('div')
          wrapper.contentEditable = 'false'
          wrapper.className = `external-rich-change-widget external-rich-change-widget-${mark.kind}${mark.edge ? ` external-rich-change-widget-${mark.edge}` : ''}`
          const button = document.createElement('button')
          button.type = 'button'
          button.className = `external-rich-change-button external-rich-change-button-${mark.kind}${mark.edge ? ` external-rich-change-button-${mark.edge}` : ''}`
          button.setAttribute('aria-label', deleted ? `查看外部删除详情：删除 ${mark.count ?? 1} 个块` : mark.kind === 'inserted' ? '查看外部新增详情' : '查看外部修改详情')
          button.setAttribute('aria-expanded', String(open === index))
          button.title = deleted ? '查看已删除的 Markdown 块' : '查看修改前后的 Markdown 块'
          button.textContent = deleted ? '\u25b6' : '\u2502'
          button.onmousedown = event => { event.preventDefault(); event.stopPropagation() }
          button.onclick = event => { event.preventDefault(); event.stopPropagation(); dispatch(index) }
          button.onkeydown = event => {
            if (event.key === 'Escape' && open === index) { event.preventDefault(); event.stopPropagation(); dispatch('close') }
            else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); dispatch(index) }
          }
          wrapper.append(button)
          return wrapper
        }, { ...options, key: `external-change-${index}-${open === index}` }))
        if (open !== index) return
        decorations.push(Decoration.widget(peekPos, () => {
          const close = () => {
            dispatch('close')
          }
          try {
            return changePeek(markdown(old, detail.oldFrom, detail.oldTo), detail.after ? markdown(doc, detail.from, detail.to) : '', close)
          } catch {
            const root = changePeek('', '', close)
            const message = document.createElement('p')
            message.textContent = '无法序列化此块的差异，请切换源码核对；正文未修改。'
            root.append(message)
            return root
          }
        }, { ...options, side: -1, key: `external-peek-${index}` }))
      })
      return { decorations: DecorationSet.create(doc, decorations), open }
    }
    view.dispatch(view.state.tr.setMeta(key, 'init').setMeta('addToHistory', false))
  })
}
