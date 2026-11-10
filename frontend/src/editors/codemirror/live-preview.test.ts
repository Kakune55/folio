import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { GFM } from '@lezer/markdown'
import { describe, expect, it, vi } from 'vitest'
import { livePreviewDecorations, taskCheckboxTransaction } from './live-preview'

function stateFor(doc: string, selection = EditorSelection.cursor(0), extensions: Extension = []) {
  const state = EditorState.create({ doc, selection, extensions: [markdown({ extensions: [GFM] }), EditorState.allowMultipleSelections.of(true), extensions] })
  ensureSyntaxTree(state, doc.length, 50)
  return state
}
function entries(set: DecorationSet) {
  const result: { from: number; to: number; spec: Record<string, unknown> }[] = []
  for (let cursor = set.iter(); cursor.value; cursor.next()) result.push({ from: cursor.from, to: cursor.to, spec: cursor.value.spec })
  return result
}
function preview(state: EditorState) { return entries(livePreviewDecorations(state, [{ from: 0, to: state.doc.length }])) }

describe('CM6 原文实时预览', () => {
  it('装饰不修改正文，所有范围有效且替换不跨行', () => {
    const doc = '光标\n# 标题 #\n> **强调** 和 `代码`\n- [ ] 任务\n[链接](./a.md) ~~删除~~\n```js\nconst a = 1\n```\n'
    const state = stateFor(doc)
    const decorations = preview(state)
    expect(state.doc.toString()).toBe(doc)
    expect(decorations.length).toBeGreaterThan(10)
    for (const range of decorations) {
      expect(range.from).toBeGreaterThanOrEqual(0)
      expect(range.to).toBeLessThanOrEqual(doc.length)
      if (!range.spec.class) expect(state.sliceDoc(range.from, range.to)).not.toContain('\n')
    }
    expect(decorations.some(range => range.spec.class === 'folio-md-heading-1')).toBe(true)
  })
  it('活动行、多选区和跨行选区保留标记', () => {
    const doc = '首行\n**强调**\n`代码`\n末行'
    const state = stateFor(doc)
    expect(preview(state).filter(range => !range.spec.class)).toHaveLength(4)
    const selected = state.update({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.range(5, doc.length)]) }).state
    expect(preview(selected).filter(range => !range.spec.class)).toHaveLength(0)
    expect(selected.doc.toString()).toBe(doc)
  })
  it('标题行样式不随活动状态切换，前缀保留占位宽度', () => {
    const doc = '首行\n## 标题 ##\n> 引用\n- 项目'
    const state = stateFor(doc)
    const inactive = preview(state)
    const active = preview(state.update({ selection: { anchor: doc.indexOf('标题') } }).state)
    expect(inactive.filter(range => range.spec.class === 'folio-md-heading-2')).toEqual(active.filter(range => range.spec.class === 'folio-md-heading-2'))
    expect(inactive.filter(range => range.spec.class === 'folio-md-marker-slot')).toHaveLength(4)
    expect(active.filter(range => range.spec.class === 'folio-md-marker-slot')).toHaveLength(2)
  })
  it('冻结期间已有装饰可映射文档变化，映射不修改正文', () => {
    const state = stateFor('首行\n**强调**\n- [ ] 任务')
    const decorations = livePreviewDecorations(state, [{ from: 0, to: state.doc.length }])
    const transaction = state.update({ changes: { from: 0, insert: '新增\n' } })
    const mapped = entries(decorations.map(transaction.changes))
    expect(mapped).toHaveLength(entries(decorations).length)
    expect(mapped.every(range => range.from >= 3 && range.to <= transaction.newDoc.length)).toBe(true)
    expect(transaction.newDoc.toString()).toBe('新增\n' + state.doc.toString())
  })
  it('不吞多行内联语法的换行，不解析图片、HTML和表格为控件', () => {
    const doc = '首行\n[a\nb](url)\n![图片](url)\n<div>**原文**</div>\n\n| a | b |\n| - | - |\n| x | y |'
    const state = stateFor(doc)
    for (const range of preview(state)) {
      if (!range.spec.class) expect(state.sliceDoc(range.from, range.to)).not.toContain('\n')
      expect(range.spec.widget).toBeUndefined()
    }
    expect(state.doc.toString()).toBe(doc)
  })
  it('任务命令仅更改中间一个字符，保留 marker、大小写外的所有字节和空格', () => {
    for (const marker of ['[ ]', '[x]', '[X]']) {
      const doc = `首行\n  -  ${marker}  待办\n`
      const state = stateFor(doc)
      const from = doc.indexOf('[')
      const spec = taskCheckboxTransaction(state, from)
      expect(spec).not.toBeNull()
      const transaction = state.update(spec!)
      expect(transaction.newDoc.toString()).toBe(doc.slice(0, from + 1) + (marker === '[ ]' ? 'x' : ' ') + doc.slice(from + 2))
      let count = 0
      transaction.changes.iterChanges((start, end, _newFrom, _newTo, inserted) => {
        count++
        expect(end - start).toBe(1)
        expect(inserted.length).toBe(1)
      })
      expect(count).toBe(1)
    }
  })
  it('只读、不可编辑与权限拒绝均不写入，并报告阻止原因', () => {
    for (const extension of [EditorState.readOnly.of(true), EditorView.editable.of(false)]) {
      const state = stateFor('- [ ] 任务', undefined, extension)
      const onBlocked = vi.fn()
      expect(taskCheckboxTransaction(state, 2, { onBlocked })).toBeNull()
      expect(onBlocked).toHaveBeenCalledOnce()
      expect(state.doc.toString()).toBe('- [ ] 任务')
    }
    const state = stateFor('- [ ] 任务')
    const onBlocked = vi.fn()
    expect(taskCheckboxTransaction(state, 2, { canEdit: () => false, onBlocked })).toBeNull()
    expect(onBlocked).toHaveBeenCalledOnce()
  })
  it('普通文本与代码内的伪任务框不允许写入，越界位置不抛错', () => {
    for (const doc of ['普通 [ ] 文本', '`- [ ] 代码`', '```\n- [ ] 代码\n```']) {
      const state = stateFor(doc)
      expect(taskCheckboxTransaction(state, doc.indexOf('['))).toBeNull()
      expect(taskCheckboxTransaction(state, -1)).toBeNull()
      expect(taskCheckboxTransaction(state, doc.length)).toBeNull()
    }
  })
  it('仅装饰视口，允许未解析尾部保留原文', () => {
    const doc = '首行\n**可见**\n' + '**尾部**\n'.repeat(10000)
    const state = EditorState.create({ doc, extensions: markdown({ extensions: [GFM] }) })
    const result = entries(livePreviewDecorations(state, [{ from: 0, to: 11 }]))
    expect(result.every(range => range.from <= 11)).toBe(true)
    expect(state.doc.toString()).toBe(doc)
  })
})
