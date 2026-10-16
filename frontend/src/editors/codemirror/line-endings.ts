import { RangeSet, RangeSetBuilder, RangeValue, StateEffect, StateField } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import { invertedEffects } from '@codemirror/commands'

class LineEnding extends RangeValue {
  readonly separator: string
  startSide = 1
  endSide = -1
  constructor(separator: string) { super(); this.separator = separator }
}
const endings = new Map(['\n', '\r', '\r\n'].map((separator) => [separator, new LineEnding(separator)]))

// CodeMirror 的文档模型统一使用 LF；只为不同于默认格式的原始换行保留不可变范围。
// 范围随事务移动、删除，历史逆向效果则精确保留被删除换行的原格式。
export function preserveLineEndings(source: string) {
  const preferred = /\r\n|\r|\n/.exec(source)?.[0] ?? '\n'
  const builder = new RangeSetBuilder<LineEnding>()
  let removed = 0
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    const position = match.index - removed
    if (match[0] !== preferred) builder.add(position, position + 1, endings.get(match[0])!)
    removed += match[0].length - 1
  }
  const initial = builder.finish()
  const restore = StateEffect.define<RangeSet<LineEnding>>({ map: (value, changes) => value.map(changes) })
  const field = StateField.define<RangeSet<LineEnding>>({
    create: () => initial,
    update: (value, transaction) => {
      value = value.map(transaction.changes)
      for (const effect of transaction.effects) if (effect.is(restore)) value = effect.value
      return value
    },
  })
  return {
    doc: source.replace(/\r\n|\r/g, '\n'),
    extension: [field, invertedEffects.of((transaction) => transaction.docChanged ? [restore.of(transaction.startState.field(field))] : [])],
    serialize(state: EditorState) {
      const text = state.doc.toString()
      if (preferred === '\n' && !state.field(field).size) return text
      const pieces: string[] = []
      let position = 0
      for (const cursor = state.field(field).iter(); cursor.value; cursor.next()) {
        if (cursor.to !== cursor.from + 1 || text[cursor.from] !== '\n') throw new Error('原始换行标记与编辑文档不一致，拒绝自动转换')
        pieces.push(text.slice(position, cursor.from).replace(/\n/g, preferred), cursor.value.separator)
        position = cursor.to
      }
      pieces.push(text.slice(position).replace(/\n/g, preferred))
      return pieces.join('')
    },
  }
}
