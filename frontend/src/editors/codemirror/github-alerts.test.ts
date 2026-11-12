import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { GFM } from '@lezer/markdown'
import type { SyntaxNode } from '@lezer/common'
import { githubAlert } from './github-alerts'
import { livePreviewDecorations } from './live-preview'
import { markdownLinkAt } from './links'
import { mathMarkdown } from './math-syntax'

function stateFor(doc: string, readonly = false) {
  const state = EditorState.create({ doc, extensions: [EditorState.readOnly.of(readonly), markdown({ base: commonmarkLanguage, extensions: [GFM, mathMarkdown] })] })
  ensureSyntaxTree(state, doc.length, 100)
  return state
}
function preview(state: EditorState, visible = [{ from: 0, to: state.doc.length }]) {
  const result: { from: number; to: number; spec: { class?: string; widget?: { type?: string } } }[] = []
  livePreviewDecorations(state, visible).between(0, state.doc.length, (from, to, decoration) => { result.push({ from, to, spec: decoration.spec }) })
  return result
}
function alerts(state: EditorState) {
  const result: NonNullable<ReturnType<typeof githubAlert>>[] = []
  syntaxTree(state).iterate({ enter(ref) {
    const alert = githubAlert(state, ref.node)
    if (alert) result.push(alert)
  } })
  return result
}

describe('GitHub 提示块', () => {
  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])('顶层 %s 标题和正文有对应装饰，原文不变', type => {
    const doc = `光标\n\n> [!${type}]\n> **说明**与\`代码\`。\n\n尾部`, state = stateFor(doc)
    const [alert] = alerts(state), decorations = preview(state)
    expect(alert.type).toBe(type)
    expect(state.sliceDoc(alert.from, alert.to)).toBe(`[!${type}]`)
    expect(decorations.filter(item => item.spec.widget?.type === type)).toHaveLength(1)
    expect(decorations.filter(item => item.spec.class === `folio-md-alert-${type.toLowerCase()}`)).toHaveLength(2)
    expect(decorations.some(item => item.spec.class === 'folio-md-strong')).toBe(true)
    expect(decorations.some(item => item.spec.class === 'folio-md-inline-code')).toBe(true)
    expect(state.doc.toString()).toBe(doc)
  })
  it.each(['>[!NOTE]', '>\t[!TIP]\t', '   > [!WARNING]  '])('允许正常引用前缀空白：%s', header => {
    const state = stateFor(`光标\n\n${header}\n> 内容\n`)
    expect(alerts(state)).toHaveLength(1)
  })
  it.each([
    '> 普通引用\n> [!NOTE]', '> [!UNKNOWN]\n> 内容', '> [!note]\n> 内容',
    '> [!NOTE] 自定义标题\n> 内容', '> \\[!NOTE]\n> 内容', '> `[!NOTE]`\n> 内容',
    '> > [!NOTE]\n> > 嵌套', '- 项目\n  > [!NOTE]\n  > 内容',
    '    > [!NOTE]\n    > 缩进代码', '```text\n> [!NOTE]\n> 内容\n```',
    '[!NOTE]\n普通段落', '<div>\n> [!NOTE]\n</div>',
    `> [!NOTE]${' '.repeat(100)}\n> 超预算标题`,
  ])('未知、嵌套、转义和代码等不误识别：%s', content => {
    const state = stateFor(`光标\n\n${content}\n\n尾部`)
    expect(alerts(state)).toHaveLength(0)
    expect(preview(state).some(item => item.spec.widget?.type)).toBe(false)
  })
  it('进入任意正文行或跨块选区时恢复标记，离开后恢复标题', () => {
    const doc = '光标\n\n> [!NOTE]\n> 第一行\n>\n> 第二段\n\n尾部', state = stateFor(doc)
    expect(preview(state).filter(item => item.spec.widget?.type)).toHaveLength(1)
    for (const selection of [{ anchor: doc.indexOf('第一行') }, { anchor: doc.indexOf('第二段') }, { anchor: 0, head: doc.length }]) {
      const active = state.update({ selection }).state
      expect(preview(active).filter(item => item.spec.widget?.type)).toHaveLength(0)
      expect(active.doc.toString()).toBe(doc)
    }
    expect(preview(state).filter(item => item.spec.class === 'folio-md-alert-line')).toHaveLength(4)
  })
  it('有空行分隔的相邻块独立渲染，正文中的新标记不会拆块', () => {
    const state = stateFor('光标\n\n> [!NOTE]\n> 内容\n> [!TIP]\n\n> [!WARNING]\n> 风险\n')
    expect(alerts(state).map(item => item.type)).toEqual(['NOTE', 'WARNING'])
    expect(preview(state).filter(item => item.spec.widget?.type).map(item => item.spec.widget?.type)).toEqual(['NOTE', 'WARNING'])
  })
  it('标题不能误当引用链接，正文链接仍可跳转', () => {
    const doc = '光标\n\n> [!NOTE]\n> [正文](./body.md)\n\n[!NOTE]: ./wrong.md'
    const state = stateFor(doc)
    expect(markdownLinkAt(doc, doc.indexOf('!NOTE'))).toBeUndefined()
    expect(markdownLinkAt(doc, doc.indexOf('正文'))).toBe('./body.md')
    expect(preview(state).filter(item => item.spec.class === 'folio-md-link')).toHaveLength(1)
    expect(preview(state.update({ selection: { anchor: doc.indexOf('正文') } }).state).filter(item => item.spec.widget?.type)).toHaveLength(0)
  })
  it('只读预览及只显示块中部仍可识别样式，不替换换行或正文', () => {
    const doc = '光标\n\n> [!TIP]\n> 第一行\n> 第二行\n\n尾部', state = stateFor(doc, true)
    expect(preview(state).filter(item => item.spec.widget?.type)).toHaveLength(1)
    const from = doc.indexOf('> 第一行'), middle = preview(state, [{ from, to: doc.indexOf('\n\n尾部') }])
    expect(middle.some(item => item.spec.class === 'folio-md-alert-tip')).toBe(true)
    expect(middle.filter(item => item.spec.widget?.type)).toHaveLength(0)
    expect(state.doc.toString()).toBe(doc)
  })
  it('只有顶层引用节点可作为入口', () => {
    const state = stateFor('光标\n\n> [!NOTE]\n> 内容'), paragraph = syntaxTree(state).topNode.firstChild!
    expect(githubAlert(state, paragraph)).toBeUndefined()
    const nested: SyntaxNode[] = []
    syntaxTree(state).iterate({ enter(ref) { if (ref.name === 'Blockquote') nested.push(ref.node) } })
    expect(githubAlert(state, nested[0])?.type).toBe('NOTE')
  })
})
