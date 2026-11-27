import type { EditorState, Text } from '@codemirror/state'

export type WordCount = { total: number; selected: number | null }

// 按原文统计：每个汉字算一字，其他连续字母或数字算一词，忽略标点及空白。
export function countWords(text: string) {
  let count = 0
  for (const _ of text.matchAll(/\p{Script=Han}|(?!\p{Script=Han})[\p{L}\p{N}](?:(?!\p{Script=Han})[\p{L}\p{M}\p{N}])*(?:['’](?!\p{Script=Han})[\p{L}\p{N}](?:(?!\p{Script=Han})[\p{L}\p{M}\p{N}])*)*/gu)) count++
  return count
}

export function createWordCounter() {
  let doc: Text | undefined, total = 0
  return (state: EditorState): WordCount => {
    if (doc !== state.doc) { doc = state.doc; total = countWords(doc.toString()) }
    const ranges = state.selection.ranges.filter(range => !range.empty)
    return { total, selected: ranges.length ? ranges.reduce((sum, range) => sum + countWords(state.sliceDoc(range.from, range.to)), 0) : null }
  }
}
