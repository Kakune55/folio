import { expect, it } from 'vitest'
import { imageMarkdown, relativeFileLink, resolveFileLink } from './bridge'
it('标准相对路径保留中文和空格，禁止逃逸与活动协议', () => {
  const target = '附件/中文 (1).png'
  const relative = relativeFileLink('笔记/子目录/记录.md', target)
  expect(relative).toBe('../../%E9%99%84%E4%BB%B6/%E4%B8%AD%E6%96%87%20%281%29.png')
  expect(resolveFileLink('笔记/子目录/记录.md', relative)).toBe(target)
  for (const link of ['../../../secret', 'javascript:alert(1)', '//evil.test/a', '%00', '..%2f..%2fsecret']) expect(() => resolveFileLink('笔记/a.md', link)).toThrow()
  expect(imageMarkdown('./image.png', '[中文]')).toBe('![\\[中文\\]](./image.png)')
})
