import { tags } from '@lezer/highlight'
import type { MarkdownConfig } from '@lezer/markdown'

const inlineLimit = 4000
const blockLimit = 20000
const blockFence = /^ {0,3}\$\$[\t ]*$/

export const mathMarkdown: MarkdownConfig = {
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
    leaf(cx, leaf) {
      if (cx.parentType().name !== 'Document' || !blockFence.test(leaf.content)) return null
      let overLimit = false
      return {
        nextLine(cx, line, leaf) {
          const to = cx.lineStart + line.text.length
          if (to - leaf.start > blockLimit) overLimit = true
          if (overLimit || cx.parentType().name !== 'Document' || !blockFence.test(line.text)) return false
          const close = cx.lineStart + line.pos
          cx.addLeafElement(leaf, cx.elt('MathBlock', leaf.start, to, [
            cx.elt('MathMark', leaf.start, leaf.start + 2),
            cx.elt('MathMark', close, close + 2),
          ]))
          cx.nextLine()
          return true
        },
        // 未闭合、空行或其他块打断时交还默认解析器，不提前消费正文。
        finish() { return false },
      }
    },
    endLeaf(cx, line, leaf) {
      return cx.parentType().name === 'Document' && blockFence.test(line.text)
        && !blockFence.test(leaf.content.split('\n', 1)[0])
    },
  }],
}
