import { tags } from '@lezer/highlight'
import { TreeFragment } from '@lezer/common'
import type { Input, Tree } from '@lezer/common'
import { BlockContext } from '@lezer/markdown'
import type { MarkdownConfig, MarkdownParser } from '@lezer/markdown'

const inlineLimit = 4000
const blockLimit = 20000
const blockFence = /^ {0,3}\$\$[\t ]*\r?$/
let activeSource: { input: Input, ranges: readonly { from: number, to: number }[], parser?: MarkdownParser } | null = null
// 混合解析的 inner 不一定是 BlockContext，通过上一棵树保留公共 parser 引用。
// fragments 须来自同一 parser 配置；CodeMirror 切换语言时会重置解析状态。
const parsedTrees = new WeakMap<Tree, MarkdownParser>()
let filteringFragments = false

export const mathMarkdown: MarkdownConfig = {
  wrap(inner, input, fragments, ranges) {
    const parser = inner instanceof BlockContext ? inner.parser : fragments.map(fragment => parsedTrees.get(fragment.tree)).find(Boolean)
    if (fragments.length && !filteringFragments && parser) {
      // 失败前瞻也依赖后续块；末端撤回预算及缩进，多 ranges 的间隙不计字符预算。
      const safe = ranges.length > 1 ? [] : fragments.flatMap(fragment => {
        const to = fragment.to - blockLimit - 3
        return to > fragment.from
          ? [new TreeFragment(fragment.from, to, fragment.tree, fragment.offset, fragment.openStart, true)]
          : []
      })
      filteringFragments = true
      try { return parser.startParse(input, safe, ranges) } finally { filteringFragments = false }
    }
    const source = { input, ranges, parser }
    return {
      advance() {
        // 仅在同步 advance 期间提供输入；兼容其他 wrapper、交错增量解析和嵌套解析。
        const previous = activeSource
        activeSource = source
        try {
          const tree = inner.advance()
          if (tree && source.parser) parsedTrees.set(tree, source.parser)
          return tree
        } finally { activeSource = previous }
      },
      get parsedPos() { return inner.parsedPos },
      get stoppedAt() { return inner.stoppedAt },
      stopAt(pos) { inner.stopAt(pos) },
    }
  },
  defineNodes: [
    'InlineMath',
    { name: 'MathBlock', block: true },
    { name: 'MathMark', style: tags.processingInstruction },
  ],
  parseInline: [{
    name: 'InlineMath',
    after: 'HTMLTag',
    parse(cx, next, pos) {
      if (next !== 36 || cx.char(pos - 1) === 36 || cx.char(pos + 1) === 36) return -1
      const end = Math.min(cx.end, pos + inlineLimit)
      for (let close = pos + 1; close < end; close++) {
        const char = cx.char(close)
        if (char === 10 || char === 13) return -1
        if (char === 92) {
          if (cx.char(close + 1) === 10 || cx.char(close + 1) === 13) return -1
          close++
          continue
        }
        if (char !== 36) continue
        // 第一个未转义边界不合法时停止，不能跨过金额寻找后续公式。
        const content = cx.slice(pos + 1, close)
        if (!content || /^\s|\s$/.test(content) || cx.char(close + 1) === 36
          || /[0-9]/.test(cx.slice(close + 1, close + 2))) return -1
        // 成对金额保持纯文本，但消费它的闭合符，避免与相邻公式重新配对。
        if (/^[+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)%?(?:\s*(?:USD|CNY|RMB|EUR|GBP|JPY|元|美元|人民币|日元|欧元|英镑))?$/i.test(content)) return close + 1
        if (/^[+-]?(?:\d|\.\d)/.test(content) && (/\s+[a-zA-Z]{2,}/.test(content.replace(/\\[a-zA-Z]+/g, '')) || !content.includes('\\') && /\p{Script=Han}/u.test(content))) return -1
        return cx.addElement(cx.elt('InlineMath', pos, close + 1, [
          cx.elt('MathMark', pos, pos + 1),
          cx.elt('MathMark', close, close + 1),
        ]))
      }
      return -1
    },
  }],
  parseBlock: [{
    name: 'MathBlock',
    before: 'SetextHeading',
    parse(cx, line) {
      if (activeSource) activeSource.parser = cx.parser
      if (cx.parentType().name !== 'Document' || !blockFence.test(line.text) || !activeSource) return false
      // ranges 外的原文不能参与闭合判断；多读一字符以区分完整末行与预算截断。
      let text = ''
      let remaining = blockLimit + line.pos + 1
      let complete = true
      for (const range of activeSource.ranges) {
        const from = Math.max(cx.parsedPos, range.from)
        if (from >= range.to) continue
        const to = Math.min(range.to, from + remaining)
        text += activeSource.input.read(from, to)
        remaining -= to - from
        if (to < range.to) { complete = false; break }
      }
      let offset = text.indexOf('\n') + 1
      while (offset > 0 && offset < text.length) {
        const newline = text.indexOf('\n', offset)
        if (newline < 0 && !complete) return false
        const end = newline < 0 ? text.length : newline
        if (end - line.pos > blockLimit) return false
        const candidate = text.slice(offset, end)
        if (/^[\t \r]*$/.test(candidate)) return false
        if (blockFence.test(candidate)) {
          const start = cx.lineStart + line.pos
          const to = cx.lineStart + end
          const close = cx.lineStart + offset + candidate.indexOf('$$')
          // 确认成功后才消费，避免未闭合或超限时吞掉后续 Markdown。
          for (let consumed = 0; consumed < end;) {
            consumed += line.text.length + 1
            if (!cx.nextLine()) break
          }
          cx.addElement(cx.elt('MathBlock', start, to, [
            cx.elt('MathMark', start, start + 2),
            cx.elt('MathMark', close, close + 2),
          ]))
          return true
        }
        offset = newline < 0 ? 0 : newline + 1
      }
      return false
    },
    endLeaf(cx, line, leaf) {
      return cx.parentType().name === 'Document' && blockFence.test(line.text)
        && !blockFence.test(leaf.content.split('\n', 1)[0])
    },
  }],
}
