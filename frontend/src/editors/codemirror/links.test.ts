import { describe, expect, it } from 'vitest'
import { markdownLinkAt } from './links'
describe('Markdown 引用跳转', () => {
  it('识别链接、图片、带空格路径与引用式链接', () => {
    for (const source of ['[打开](./目标%20文件.md)', '![打开](./图片.png)', '[打开](<./目标 文件.md>)', '[打开][REF]\n\n[ref]: ./目标.md', '[打开][]\n\n[打开]: ./目标.md', '[打开]\n\n[打开]: ./目标.md']) {
      expect(markdownLinkAt(source, source.indexOf('打开') + 1)).toMatch(/^\.\//)
    }
    expect(markdownLinkAt('[打开](./a\\(b\\).md)', 2)).toBe('./a(b).md')
  })
  it('代码中的伪引用与普通文字不触发跳转', () => {
    for (const source of ['`[打开](./目标.md)`', '```md\n[打开](./目标.md)\n```', '普通文字打开', '[打开][不存在]']) {
      expect(markdownLinkAt(source, source.indexOf('打开') + 1)).toBeUndefined()
    }
  })
})
