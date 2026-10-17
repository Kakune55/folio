import { useEffect, useState } from 'react'
import type { Crepe } from '@milkdown/crepe'
import { editorViewCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'

export function RichNavigation({ editor }: { editor: Crepe }) {
  const [headings, setHeadings] = useState<{ text: string; level: number; position: number }[]>([])
  useEffect(() => editor.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const refresh = () => {
      const next: typeof headings = []
      view.state.doc.descendants((node, position) => {
        if (node.type.name === 'heading') next.push({ text: node.textContent, level: Number(node.attrs.level), position })
      })
      setHeadings(next)
    }
    refresh()
    let timer: ReturnType<typeof setTimeout>
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(refresh, 150) })
    observer.observe(view.dom, { subtree: true, childList: true, characterData: true })
    return () => { observer.disconnect(); clearTimeout(timer) }
  }), [editor])
  return <aside className="document-navigation" aria-label="Markdown 大纲"><div className="navigation-title">大纲</div><nav aria-label="标题导航">{headings.length ? headings.map((heading) => <button key={heading.position} style={{ paddingInlineStart: 12 + (heading.level - 1) * 12 }} title={heading.text} onClick={() => editor.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, heading.position + 1)).scrollIntoView())
    view.focus()
  })}>{heading.text || '无文字标题'}</button>) : <p>当前文档没有标题</p>}</nav></aside>
}
