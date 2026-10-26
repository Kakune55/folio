import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { history, undo, redo } from '@milkdown/kit/prose/history'
import type { EditorView } from '@milkdown/kit/prose/view'
import { createMarkdownCodeInputPlugin, parseMarkdownCodeFence } from './markdown-input'

const schema = new Schema({ nodes: {
  doc: { content: 'block+' },
  paragraph: { content: 'inline*', group: 'block' },
  heading: { content: 'inline*', group: 'block' },
  blockquote: { content: 'block+', group: 'block' },
  code_block: { content: 'text*', group: 'block', code: true, marks: '', attrs: { language: { default: '' } } },
  image: { inline: true, group: 'inline' },
  text: { group: 'inline' },
} })

function setup(marker: string, options: { nested?: boolean; type?: string; offset?: number; selected?: boolean } = {}) {
  const paragraph = schema.node(options.type ?? 'paragraph', null, schema.text(marker))
  const target = options.nested ? schema.node('blockquote', null, paragraph) : paragraph
  const doc = schema.node('doc', null, [target, schema.node('paragraph', null, schema.text('正文 c++ ``` 不动'))])
  const start = options.nested ? 2 : 1
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, start + (options.offset ?? marker.length), options.selected ? start : undefined), plugins: [history()] })
  const view = { get state() { return state }, composing: false, dispatch: (tr: Parameters<EditorView['dispatch']>[0]) => { state = state.apply(tr) } }
  const plugin = createMarkdownCodeInputPlugin()
  const press = (key = 'Enter', extras = {}) => plugin.props.handleKeyDown!.call(plugin, view as EditorView, { key, ...extras } as KeyboardEvent)
  return { view, press }
}

describe('代码围栏识别', () => {
  it.each(['```', '````', '~~~', '~~~~~~', '```c++', '~~~c#', '````shell-session', '~~~~json'])('接受 %s', text => {
    expect(parseMarkdownCodeFence(text)).toEqual({ language: text.replace(/^[`~]+/, '') })
  })
  it.each(['``', '~~', '～～～', '```~', '~~~`', '`~`', '```c++ 正文', '~~~json\n', ' ```', '> ```', '- ~~~', '``` json', '```c`', '~~~c~'])('拒绝 %s', text => {
    expect(parseMarkdownCodeFence(text)).toBeNull()
  })
})

describe('代码围栏事务（无 DOM）', () => {
  it.each(['Enter', ' '])('以 %s 转换 marker，保留语言、相邻正文和历史', key => {
    const { view, press } = setup('~~~~c++')
    const original = view.state.doc
    expect(press(key)).toBe(true)
    expect(view.state.doc.firstChild?.type.name).toBe('code_block')
    expect(view.state.doc.firstChild?.attrs.language).toBe('c++')
    expect(view.state.doc.firstChild?.textContent).toBe('')
    expect(view.state.doc.lastChild?.eq(original.lastChild!)).toBe(true)
    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.eq(original)).toBe(true)
    expect(redo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.firstChild?.type.name).toBe('code_block')
  })
  it('转换引用内的段落，不删除嵌套结构', () => {
    const { view, press } = setup('```shell-session', { nested: true })
    expect(press()).toBe(true)
    expect(view.state.doc.firstChild?.type.name).toBe('blockquote')
    expect(view.state.doc.firstChild?.firstChild?.attrs.language).toBe('shell-session')
  })
  it.each([{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }])('不抢修饰键或输入法 %j', extras => {
    const { view, press } = setup('~~~json')
    const original = view.state.doc
    expect(press('Enter', extras)).toBe(false)
    expect(view.state.doc.eq(original)).toBe(true)
  })
  it.each([{ selected: true }, { offset: 3 }, { type: 'heading' }, { type: 'code_block' }])('拒绝不安全位置 %j', options => {
    const { press } = setup('```json', options)
    expect(press()).toBe(false)
  })
  it('拒绝正文后缀和 composing view', () => {
    expect(setup('```json 正文', { offset: 7 }).press()).toBe(false)
    const { view, press } = setup('~~~')
    view.composing = true
    expect(press()).toBe(false)
  })
})
