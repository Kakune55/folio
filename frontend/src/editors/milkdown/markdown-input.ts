import { $prose } from '@milkdown/kit/utils'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'

// 只接受 ASCII 围栏和单个语言标识，不将空白后的正文当作语言。
export const markdownCodeFenceRegex = /^(?:`{3,}|~{3,})([A-Za-z0-9_][A-Za-z0-9_+#.-]*)?$/

export function parseMarkdownCodeFence(text: string): { language: string } | null {
  const match = markdownCodeFenceRegex.exec(text)
  // JS 的 $ 也匹配末尾换行之前；这里要求真正匹配完整段落。
  return match && match[0] === text ? { language: match[1] ?? '' } : null
}

export function createMarkdownCodeInputPlugin() {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if ((event.key !== 'Enter' && event.key !== ' ') || event.shiftKey || event.ctrlKey
          || event.metaKey || event.altKey || event.isComposing || view.composing || event.keyCode === 229) return false
        const { state } = view
        const { selection, schema } = state
        if (!(selection instanceof TextSelection) || !selection.empty) return false
        const { $from } = selection
        if ($from.parent.type !== schema.nodes.paragraph || $from.parentOffset !== $from.parent.content.size) return false
        // textContent 会忽略内联原子节点，不能仅依赖它判断整段是否只有 marker。
        if ($from.parent.childCount !== 1 || !$from.parent.firstChild?.isText) return false
        const attrs = parseMarkdownCodeFence($from.parent.textContent)
        const codeBlock = schema.nodes.code_block
        if (!attrs || !codeBlock || !$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), codeBlock)) return false
        const start = $from.start()
        view.dispatch(state.tr.delete(start, $from.end()).setBlockType(start, start, codeBlock, attrs).scrollIntoView())
        return true
      },
    },
  })
}

export const markdownCodeInput = $prose(() => createMarkdownCodeInputPlugin())
