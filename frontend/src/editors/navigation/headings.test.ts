import { describe, expect, it } from 'vitest'
import { sourceHeadings } from './headings'

describe('Markdown 大纲', () => {
  it('识别层级、重复标题与 Setext，排除代码和 HTML 注释中的伪标题', () => {
    const source = '# 同名\n\n```md\n# 代码\n```\n\n<!--\n# 注释\n-->\n\n## 同名\n\n末尾\n===\n'
    const result = sourceHeadings(source)
    expect(result.map(({ text, level }) => [text, level])).toEqual([['同名', 1], ['同名', 2], ['末尾', 1]])
    expect(result[1].from).toBe(source.indexOf('## 同名'))
  })
})
