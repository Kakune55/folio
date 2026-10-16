export type SearchTarget = { id: number; path: string; query: string; contentMatch: boolean }
export type SearchLocated = (target: SearchTarget, found: boolean) => void

// 对齐服务端字面匹配：仅折叠 ASCII 大小写，不改变 UTF-16 长度和编辑器位置。
export function literalRange(text: string, query: string) {
  if (!query) return undefined
  const fold = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const from = fold(text).indexOf(fold(query))
  return from < 0 ? undefined : { from, to: from + query.length }
}
