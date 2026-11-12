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
  it.each(['---', '***', '___', '- - -', '* * *', '_ _ _', '   ----'])('分割线 %s 渲染为分隔控件，活动行可编辑原标记', rule => {
    const doc = `首行\n\n${rule}\n\n末行`, state = stateFor(doc)
    const rendered = preview(state)
    expect(rendered.filter(range => range.spec.class === 'folio-md-rule-line')).toHaveLength(1)
    expect(rendered.filter(range => range.spec.widget)).toHaveLength(1)
    expect(preview(state.update({ selection: { anchor: doc.indexOf(rule) } }).state).filter(range => range.spec.widget)).toHaveLength(0)
    expect(state.doc.toString()).toBe(doc)
  })
  it('Setext 下划线、转义、行内代码和围栏中的伪分割线不误渲染', () => {
    for (const source of ['标题\n---', '\\---', '`---`', '```text\n---\n```', '    ---']) {
      const doc = `首行\n\n${source}\n\n末行`
      expect(preview(stateFor(doc)).some(range => range.spec.class === 'folio-md-rule-line')).toBe(false)
    }
  })
  it('Setext 仅正文行使用标题字号，不放大下划线占位行', () => {
    const doc = '光标\n\n标题\n===\n\n尾部', state = stateFor(doc)
    expect(preview(state).filter(range => range.spec.class === 'folio-md-heading-1').map(range => range.from)).toEqual([doc.indexOf('标题')])
  })
  it('只有有目标的引用、尖括号和裸 URL 显示为链接', () => {
    const doc = '光标\n\n[有效][id] [无效][missing] [无定义]\n\n<https://example.com> https://example.org www.example.net\n\n[id]: ./note.md\n'
    const state = stateFor(doc)
    const links = preview(state).filter(range => range.spec.class === 'folio-md-link').map(range => state.sliceDoc(range.from, range.to))
    expect(links).toEqual(['[有效][id]', '<https://example.com>', 'https://example.org', 'www.example.net'])
    for (const missing of ['[无效][missing]', '[无定义]']) {
      const from = doc.indexOf(missing)
      expect(preview(state).some(range => !range.spec.class && range.from >= from && range.to <= from + missing.length)).toBe(false)
    }
    expect(state.doc.toString()).toBe(doc)
  })
  it('转义与硬换行只隐藏标记，不吞换行；实体仅替换为文本控件', () => {
    const doc = '光标\n\n\\*普通\\* &amp; &#65; &notreal;\n反斜线\\\n下一行  \n尾部'
    const state = stateFor(doc), decorations = preview(state)
    expect(decorations.filter(range => range.spec.widget)).toHaveLength(3)
    expect(decorations.filter(range => !range.spec.class && !range.spec.widget).map(range => state.sliceDoc(range.from, range.to))).toEqual(['\\', '\\', '\\', '  '])
    expect(preview(state.update({ selection: { anchor: doc.indexOf('&amp;') } }).state).filter(range => range.spec.widget)).toHaveLength(0)
    expect(state.doc.toString()).toBe(doc)
  })
  it.each([
    ['# 一级', 'heading-1'], ['## 二级', 'heading-2'], ['### 三级', 'heading-3'],
    ['#### 四级', 'heading-4'], ['##### 五级', 'heading-5'], ['###### 六级', 'heading-6'],
    ['一级\n====', 'heading-1'], ['二级\n----', 'heading-2'],
    ['*斜体*', 'emphasis'], ['_斜体_', 'emphasis'], ['**粗体**', 'strong'], ['__粗体__', 'strong'],
    ['***粗斜体***', 'strong'], ['~~删除~~', 'strike'], ['`行内代码`', 'inline-code'], ['``a ` b``', 'inline-code'],
    ['> 引用\n>\n> > 嵌套引用', 'quote-line'], ['- 项目\n  - 嵌套', 'list-line'], ['3. 项目\n4. 后项', 'list-line'],
    ['[标题](./note.md "说明")', 'link'], ['[引用][id]\n\n[id]: ./note.md', 'link'],
    ['```js\nconst x = 1\n```', 'code-line'], ['~~~text\n原文\n~~~', 'code-line'], ['    缩进代码', 'code-line'],
  ])('基础语法 %s 有对应显示装饰且不改原文', (source, className) => {
    const doc = `光标\n\n${source}\n\n尾部`, state = stateFor(doc)
    expect(preview(state).some(range => range.spec.class === `folio-md-${className}`)).toBe(true)
    expect(state.doc.toString()).toBe(doc)
  })
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
