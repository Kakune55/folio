import { EditorSelection, EditorState } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { expect, it } from 'vitest'
import { markdownCommands } from './markdown-commands'

function setup(source: string, from: number, to = from, readOnly = false) {
  const value = { state: EditorState.create({ doc: source, selection: EditorSelection.range(from, to), extensions: [history(), EditorState.readOnly.of(readOnly)] }), focus() {}, dispatch(spec: Parameters<EditorState['update']>[0]) { value.state = value.state.update(spec).state } }
  return value as unknown as EditorView
}
it('局部包裹与移除标记，撤销恢复原文', () => {
  const view = setup('未动\n目标\n尾部', 3, 5)
  markdownCommands.bold(view)
  expect(view.state.doc.toString()).toBe('未动\n**目标**\n尾部')
  markdownCommands.bold(view)
  expect(view.state.doc.toString()).toBe('未动\n目标\n尾部')
  markdownCommands.code(view)
  expect(view.state.doc.toString()).toBe('未动\n`目标`\n尾部')
  undo(view)
  expect(view.state.doc.toString()).toBe('未动\n目标\n尾部')
})
it('空光标在闭合标记前可退出，不添加重复标记', () => {
  const view = setup('**text**', 6)
  markdownCommands.bold(view)
  expect(view.state.doc.toString()).toBe('**text**')
  expect(view.state.selection.main.head).toBe(8)
})
it('逐行前缀只改选中行，已有换行与其他文字不动', () => {
  const view = setup('首\n甲\n乙\n尾', 2, 6)
  markdownCommands.bullet(view)
  expect(view.state.doc.toString()).toBe('首\n- 甲\n- 乙\n尾')
  markdownCommands.bullet(view)
  expect(view.state.doc.toString()).toBe('首\n甲\n乙\n尾')
})
it('只读状态所有格式入口不写正文', () => {
  for (const command of Object.values(markdownCommands)) {
    const view = setup('原文', 0, 2, true)
    command(view)
    expect(view.state.doc.toString()).toBe('原文')
  }
})
it('选中文字插链接后光标在URL位置，不误替换原标签', () => {
  const view = setup('前 word 后', 2, 6)
  markdownCommands.link(view)
  expect(view.state.doc.toString()).toBe('前 [word]() 后')
  expect(view.state.selection.main.head).toBe(9)
})
