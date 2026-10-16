// 用单个替换区间展示差异，避免大文档的二次方逐行匹配；保留换行差异。
export function conversionDiff(original: string, converted: string) {
  const lines = (text: string) => text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? []
  const before = lines(original), after = lines(converted)
  let start = 0, endBefore = before.length, endAfter = after.length
  while (start < endBefore && start < endAfter && before[start] === after[start]) start++
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter-- }
  if (start === endBefore && start === endAfter) return '无差异'
  const display = (line: string) => line.endsWith('\r\n') ? `${line.slice(0, -2)} [CRLF]` : line.endsWith('\r') ? `${line.slice(0, -1)} [CR]` : line.endsWith('\n') ? `${line.slice(0, -1)} [LF]` : `${line} [EOF]`
  return [
    `@@ -${start + 1},${endBefore - start} +${start + 1},${endAfter - start} @@`,
    ...before.slice(start, endBefore).map((line) => `- ${display(line)}`),
    ...after.slice(start, endAfter).map((line) => `+ ${display(line)}`),
  ].join('\n')
}
