import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMermaidPreview, mermaidSourceError } from './mermaid-preview'
const renderer = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: renderer }))
describe('Mermaid 渲染边界', () => {
  it('保留普通图表与双向箭头', () => {
    for (const source of ['flowchart LR\nA[开始] --> B[结束]', 'sequenceDiagram\nA->>B: 内容', 'flowchart LR\nA<-->B']) expect(mermaidSourceError(source)).toBeUndefined()
  })
  it('拒绝配置覆盖、活动标签、图片与样式资源', () => {
    for (const source of ['%%{init: {"securityLevel":"loose"}}%%', '---\nconfig:\n securityLevel: loose\n---', 'flowchart LR\nA["<img src=https://evil.test>"]', 'flowchart LR\nA@{img: "https://evil.test"}', 'flowchart LR\nA-->B;style A fill:red', 'flowchart LR\nclick A "javascript:alert(1)"']) expect(mermaidSourceError(source)).toBeTruthy()
    expect(mermaidSourceError('A'.repeat(50001))).toContain('50000')
  })
})

// 仅模拟 DOM 生命周期，不启动浏览器或执行 SVG。
class ElementStub {
  children: ElementStub[] = []
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  textContent = ''
  alt = ''
  src = ''
  className = ''
  constructor(readonlyTag: string = 'div') { this.tag = readonlyTag }
  tag: string
  replaceChildren(...children: ElementStub[]) { this.children = children }
  setAttribute() {}
  contains(target: ElementStub): boolean { return this === target || this.children.some(child => child.contains(target)) }
  querySelector(tag: string): ElementStub | null { for (const child of this.children) { if (child.tag === tag) return child; const found = child.querySelector(tag); if (found) return found }; return null }
  decode() { return Promise.resolve() }
}
describe('共享 Mermaid 生命周期', () => {
  let root: ElementStub, theme: ElementStub, observers: (() => void)[]
  beforeEach(() => {
    vi.useFakeTimers()
    renderer.initialize.mockReset()
    renderer.render.mockReset().mockResolvedValue({ svg: '<svg viewBox="0 0 200 100"></svg>' })
    root = new ElementStub(); theme = new ElementStub(); observers = []
    vi.stubGlobal('MutationObserver', class { constructor(callback: () => void) { observers.push(callback) } observe() {} disconnect() {} })
    vi.stubGlobal('document', { documentElement: theme, createElement: (tag: string) => new ElementStub(tag), getElementById: () => null })
    vi.stubGlobal('DOMParser', class { parseFromString() { return { documentElement: { getAttribute: () => '0 0 200 100' } } } })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  it('串行安全配置，隔离 IMG，主题更新失败保留旧图', async () => {
    const preview = createMermaidPreview(root as unknown as HTMLElement)
    const host = preview.render('mermaid', 'flowchart LR\nA-->B') as unknown as ElementStub
    root.replaceChildren(host)
    await vi.advanceTimersByTimeAsync(600)
    expect(renderer.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', htmlLabels: false, maxTextSize: 50000, maxEdges: 500 }))
    const image = host.querySelector('img')!
    expect(image.src).toMatch(/^data:image\/svg\+xml/)
    expect(host.querySelector('svg')).toBeNull()
    expect(host.dataset.state).toBe('ready')
    renderer.render.mockRejectedValueOnce(new Error('失败'))
    theme.dataset.theme = 'dark'
    observers[1]()
    expect(host.querySelector('img')).toBe(image)
    await vi.advanceTimersByTimeAsync(120)
    expect(renderer.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }))
    expect(host.dataset.state).toBe('error')
    expect(host.querySelector('img')).toBe(image)
    expect(host.children.at(-1)?.textContent).toContain('代码已保留')
    preview.destroy()
  })
  it('销毁与移除后不应用迟到的异步结果', async () => {
    let resolve!: (result: { svg: string }) => void
    renderer.render.mockImplementationOnce(() => new Promise(result => { resolve = result }))
    const preview = createMermaidPreview(root as unknown as HTMLElement)
    const host = preview.render('mermaid', 'flowchart LR\nA-->B') as unknown as ElementStub
    root.replaceChildren(host)
    await vi.advanceTimersByTimeAsync(600)
    expect(renderer.render).toHaveBeenCalledOnce()
    preview.destroy()
    resolve({ svg: '<svg></svg>' })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.querySelector('img')).toBeNull()
    expect(preview.render('mermaid', 'flowchart LR\nA-->B')).toBeNull()
  })
  it('多实例共享渲染队列，前一个完成前不启动后一个', async () => {
    let resolve!: (result: { svg: string }) => void
    renderer.render.mockImplementationOnce(() => new Promise(result => { resolve = result }))
    const secondRoot = new ElementStub()
    const first = createMermaidPreview(root as unknown as HTMLElement), second = createMermaidPreview(secondRoot as unknown as HTMLElement)
    root.replaceChildren(first.render('mermaid', 'flowchart LR\nA-->B') as unknown as ElementStub)
    secondRoot.replaceChildren(second.render('mermaid', 'flowchart LR\nB-->C') as unknown as ElementStub)
    await vi.advanceTimersByTimeAsync(600)
    expect(renderer.render).toHaveBeenCalledOnce()
    resolve({ svg: '<svg></svg>' })
    await vi.advanceTimersByTimeAsync(0)
    expect(renderer.render).toHaveBeenCalledTimes(2)
    first.destroy(); second.destroy()
  })
})
