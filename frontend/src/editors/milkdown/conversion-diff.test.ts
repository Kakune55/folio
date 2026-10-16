import { describe, expect, it } from 'vitest'
import { conversionDiff } from './conversion-diff'

describe('conversionDiff', () => {
  it('省略相同首尾并保留中间替换区间', () => {
    expect(conversionDiff('首行\n旧文\n尾行\n', '首行\n新文\n尾行\n')).toBe('@@ -2,1 +2,1 @@\n- 旧文 [LF]\n+ 新文 [LF]')
  })
  it('展示删除、新增和空文档', () => {
    expect(conversionDiff('原文', '')).toBe('@@ -1,1 +1,0 @@\n- 原文 [EOF]')
    expect(conversionDiff('', '正文\n')).toBe('@@ -1,0 +1,1 @@\n+ 正文 [LF]')
    expect(conversionDiff('', '')).toBe('无差异')
  })
  it('区分空行、行尾空格及所有换行类型', () => {
    expect(conversionDiff('甲 \r\n\r乙\n末', '甲\n\n乙\n末\n')).toBe('@@ -1,4 +1,4 @@\n- 甲  [CRLF]\n-  [CR]\n- 乙 [LF]\n- 末 [EOF]\n+ 甲 [LF]\n+  [LF]\n+ 乙 [LF]\n+ 末 [LF]')
    expect(conversionDiff('\n', '')).toContain('-  [LF]')
  })
  it('大文档不需要逐行矩阵匹配', () => {
    const text = '相同\n'.repeat(100_000)
    expect(conversionDiff(`${text}旧`, `${text}新`)).toBe('@@ -100001,1 +100001,1 @@\n- 旧 [EOF]\n+ 新 [EOF]')
  })
})
