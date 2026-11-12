import { RangeSet, RangeSetBuilder, RangeValue, StateEffect, StateField } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'
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
  const bom = source.startsWith('\ufeff') ? '\ufeff' : ''
  const body = source.slice(bom.length)
  const preferred = /\r\n|\r|\n/.exec(body)?.[0] ?? '\n'
  const builder = new RangeSetBuilder<LineEnding>()
  let removed = 0
  for (const match of body.matchAll(/\r\n|\r|\n/g)) {
    const position = match.index - removed
    if (match[0] !== preferred) builder.add(position, position + 1, endings.get(match[0])!)
    removed += match[0].length - 1
  }
  const initial = builder.finish()
  const restore = StateEffect.define<RangeSet<LineEnding>>({ map: (value, changes) => value.map(changes) })
  const insert = StateEffect.define<Range<LineEnding>[]>()
  const field = StateField.define<RangeSet<LineEnding>>({
    create: () => initial,
    update: (value, transaction) => {
      value = value.map(transaction.changes)
      for (const effect of transaction.effects) {
        if (effect.is(restore)) value = effect.value
        if (effect.is(insert)) value = value.update({ add: effect.value, sort: true })
      }
      return value
    },
  })
  return {
    doc: body.replace(/\r\n|\r/g, '\n'),
    extension: [field, invertedEffects.of((transaction) => transaction.docChanged ? [restore.of(transaction.startState.field(field))] : [])],
    paste(state: EditorState, source: string) {
      const normalized = source.replace(/\r\n|\r/g, '\n')
      const spec = state.replaceSelection(normalized)
      const ranges: Range<LineEnding>[] = []
      state.changes(spec.changes).iterChanges((_from, _to, from, _toB, text) => {
        if (text.toString() !== normalized) throw new Error('粘贴选区无法安全映射原始换行，请分别粘贴')
        let removed = 0
        for (const match of source.matchAll(/\r\n|\r|\n/g)) {
          const position = from + match.index - removed
          if (match[0] !== preferred) ranges.push(endings.get(match[0])!.range(position, position + 1))
          removed += match[0].length - 1
        }
      })
      return { ...spec, effects: insert.of(ranges), userEvent: 'input.paste', scrollIntoView: true }
    },
    serialize(state: EditorState) {
      const text = state.doc.toString()
      if (preferred === '\n' && !state.field(field).size) return bom + text
      const pieces: string[] = [bom]
      let position = 0
      for (const cursor = state.field(field).iter(); cursor.value; cursor.next()) {
        if (cursor.to !== cursor.from + 1 || text[cursor.from] !== '\n') throw new Error('原始换行标记与编辑文档不一致，拒绝自动转换')
        pieces.push(text.slice(position, cursor.from).replace(/\n/g, preferred), cursor.value.separator)
        position = cursor.to
      }
      pieces.push(text.slice(position).replace(/\n/g, preferred))
      return pieces.join('')
    },
    slice(state: EditorState, from: number, to: number) {
      if (from < 0 || to < from || to > state.doc.length) throw new Error('复制范围已失效，未复制片段')
      const text = state.doc.toString(), pieces: string[] = []
      let position = from
      for (const cursor = state.field(field).iter(from); cursor.value && cursor.from < to; cursor.next()) {
        if (cursor.from < from) continue
        if (cursor.to !== cursor.from + 1 || text[cursor.from] !== '\n') throw new Error('原始换行映射不一致，未复制')
        pieces.push(text.slice(position, cursor.from).replace(/\n/g, preferred), cursor.value.separator)
        position = cursor.to
      }
      pieces.push(text.slice(position, to).replace(/\n/g, preferred))
      return pieces.join('')
    },
  }
}
