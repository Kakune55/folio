import { describe, expect, it } from 'vitest'
import { mermaidSourceError } from './mermaid-preview'
describe('Mermaid 渲染边界', () => {
  it('保留普通图表与双向箭头', () => {
    for (const source of ['flowchart LR\nA[开始] --> B[结束]', 'sequenceDiagram\nA->>B: 内容', 'flowchart LR\nA<-->B']) expect(mermaidSourceError(source)).toBeUndefined()
  })
  it('拒绝配置覆盖、活动标签、图片与样式资源', () => {
    for (const source of ['%%{init: {"securityLevel":"loose"}}%%', '---\nconfig:\n securityLevel: loose\n---', 'flowchart LR\nA["<img src=https://evil.test>"]', 'flowchart LR\nA@{img: "https://evil.test"}', 'flowchart LR\nA-->B;style A fill:red', 'flowchart LR\nclick A "javascript:alert(1)"']) expect(mermaidSourceError(source)).toBeTruthy()
    expect(mermaidSourceError('A'.repeat(50001))).toContain('50000')
  })
})
