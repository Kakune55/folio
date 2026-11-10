import { markdown } from '@codemirror/lang-markdown'
import { EditorState, StateEffect } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { GFM } from '@lezer/markdown'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorBridge } from '../bridge'
import { markdownPreviewBlocks } from './preview-blocks'

const options = {}
function state(doc: string, anchor = 0) {
  return EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ extensions: [GFM] }), markdownPreviewBlocks(options)] })
}
function decorations(state: EditorState) {
  const result: { from: number; to: number; value: Decoration }[] = []
  for (const provider of state.facet(EditorView.decorations)) {
    if (typeof provider === 'function') continue
    ;(provider as DecorationSet).between(0, state.doc.length, (from, to, value) => { result.push({ from, to, value }) })
  }
  return result
}

afterEach(() => vi.unstubAllGlobals())
describe('CM6 块预览', () => {
  const table = '前言\n\n| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 2 |\n\n末尾'
  it('通过 StateField 提供表格 block decoration，进入任意选区恢复源码', () => {
    let current = state(table)
    const [item] = decorations(current)
    expect(item.value.spec.block).toBe(true)
    expect(current.sliceDoc(item.from, item.to)).toContain('| 苹果 |')
    current = current.update({ selection: { anchor: table.indexOf('苹果') } }).state
    expect(decorations(current)).toHaveLength(0)
    current = current.update({ selection: { anchor: 0, head: table.indexOf('末尾') } }).state
    expect(decorations(current)).toHaveLength(0)
    current = current.update({ selection: { anchor: 0 } }).state
    expect(decorations(current)).toHaveLength(1)
    expect(current.doc.toString()).toBe(table)
  })
  it('相同尺寸、不同内容或位置的表格不能错误复用', () => {
    const first = decorations(state(table))[0].value.spec.widget
    const second = decorations(state(table.replace('苹果', '香蕉')))[0].value.spec.widget
    expect(first.eq(second)).toBe(false)
    const moved = decorations(state(`增加\n\n${table}`))[0].value.spec.widget
    expect(first.eq(moved)).toBe(false)
    expect(first.eq(decorations(state(table))[0].value.spec.widget)).toBe(true)
  })
  it('复杂 cell、列数不齐和嵌套表格保守显示源码', () => {
    for (const text of [table.replace('苹果', '**苹果**'), table.replace('苹果', '<img src=x>'), table.replace('| 苹果 | 2 |', '| 苹果 |'), table.split('\n').map(line => `> ${line}`).join('\n')]) expect(decorations(state(text))).toHaveLength(0)
  })
  it('图片及 Mermaid 附加在原文之后，不替换可编辑源码', () => {
    for (const doc of ['![说明](./a.png)', '```mermaid\nflowchart LR\nA-->B\n```']) {
      const current = state(doc), [item] = decorations(current)
      expect(item.from).toBe(doc.length)
      expect(item.to).toBe(doc.length)
      expect(item.value.spec.block).toBe(true)
      expect(item.value.spec.side).toBe(1)
      expect(current.doc.toString()).toBe(doc)
    }
    expect(decorations(state('```js\nhello\n```'))).toHaveLength(0)
    const inline = '文字 ![a\\]b](./a.png)'
    const [item] = decorations(state(inline))
    expect(item.from).toBe(inline.length)
    expect(item.value.spec.widget.label).toBe('a]b')
  })
  it('远程差异待确认时表格保留源码行，清理效果不触碰正文', () => {
    let reveal = false
    const refresh = StateEffect.define<void>()
    let current = EditorState.create({ doc: table, extensions: [markdown({ extensions: [GFM] }), markdownPreviewBlocks({ revealTables: () => reveal })] })
    expect(decorations(current)).toHaveLength(1)
    reveal = true; current = current.update({ effects: refresh.of() }).state
    expect(decorations(current)).toHaveLength(0)
    reveal = false; current = current.update({ effects: refresh.of() }).state
    expect(decorations(current)).toHaveLength(1)
    expect(current.doc.toString()).toBe(table)
  })
  it('解析预算外的资源保持源码', () => {
    expect(decorations(state(`${'正文\n\n'.repeat(26000)}![说明](./a.png)`))).toHaveLength(0)
  })
  it('只读表格点击 cell 仅定位精确源码范围，不写正文', () => {
    type Stub = { tagName: string; textContent: string; children: Stub[]; listeners: Record<string, (event: unknown) => void>; append: (...nodes: Stub[]) => void; addEventListener: (name: string, callback: (event: unknown) => void) => void }
    const nodes: Stub[] = []
    vi.stubGlobal('document', { createElement: (tagName: string) => {
      const node: Stub = { tagName, textContent: '', children: [], listeners: {}, append(...children) { this.children.push(...children) }, addEventListener(name, callback) { this.listeners[name] = callback } }
      nodes.push(node)
      return node
    } })
    const current = EditorState.create({ doc: table, extensions: [EditorState.readOnly.of(true), markdown({ extensions: [GFM] }), markdownPreviewBlocks({ canEdit: () => false })] })
    const dispatch = vi.fn(), focus = vi.fn()
    decorations(current)[0].value.spec.widget.toDOM({ dispatch, focus })
    const cell = nodes.find(node => node.tagName === 'td' && node.textContent === '苹果')!
    cell.listeners.click({})
    expect(dispatch).toHaveBeenCalledWith({ selection: { anchor: table.indexOf('苹果'), head: table.indexOf('苹果') + 2 }, scrollIntoView: true })
    expect(dispatch.mock.calls[0][0]).not.toHaveProperty('changes')
    expect(focus).toHaveBeenCalledOnce()
    expect(current.doc.toString()).toBe(table)
    expect(nodes.some(node => 'contentEditable' in node || 'innerHTML' in node)).toBe(false)
  })
  it('图片只使用 bridge 授权 URL；外部地址不能绕过，错误保持可见', () => {
    const elements: { tagName: string; children: unknown[]; textContent: string; src?: string; onerror?: () => void }[] = []
    vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('ResizeObserver', undefined)
    vi.stubGlobal('document', { createElement: (tagName: string) => {
      const node = { tagName, children: [] as unknown[], textContent: '', append(...children: unknown[]) { this.children.push(...children) }, addEventListener() {} }
      elements.push(node)
      return node
    } })
    const imageURL = vi.fn(() => '/api/authorized-image'), bridge = { imageURL } as unknown as EditorBridge
    const make = (href: string) => {
      const current = EditorState.create({ doc: `![说明](${href})`, extensions: [markdown(), markdownPreviewBlocks({ bridge })] })
      return decorations(current)[0].value.spec.widget
    }
    const widget = make('./image.png'), view = { requestMeasure: vi.fn() } as unknown as EditorView
    const root = widget.toDOM(view)
    expect(imageURL).toHaveBeenCalledWith('./image.png')
    const image = elements.find(element => element.tagName === 'img')!
    expect(image.src).toBe('/api/authorized-image')
    image.onerror!()
    expect(elements.some(element => element.textContent.includes('图片加载失败'))).toBe(true)
    // CM 可把 eq 相等的新 widget 绑定到旧 DOM，销毁仍须取消旧回调。
    make('./image.png').destroy(root)
    expect(image.onerror).toBeNull()
    imageURL.mockClear()
    make('https://evil.test/image.png').toDOM(view)
    expect(imageURL).not.toHaveBeenCalled()
    expect(elements.some(element => element.textContent.includes('不支持外部图片地址'))).toBe(true)
  })
})
