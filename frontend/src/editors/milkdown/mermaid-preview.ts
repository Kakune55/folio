import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language'
// 注册语言选择入口；Mermaid 的语法校验由渲染器完成，代码区按纯文本编辑。
export const mermaidLanguage = LanguageDescription.of({ name: 'mermaid', support: new LanguageSupport(StreamLanguage.define({ token(stream) { stream.skipToEnd(); return null } })) })

let queue: Promise<unknown> = Promise.resolve()
let modulePromise: Promise<typeof import('mermaid')> | undefined
const loadMermaid = () => modulePromise ??= import('mermaid').catch(error => { modulePromise = undefined; throw error })

export function mermaidSourceError(source: string) {
  if (!source.trim()) return '请输入 Mermaid 图表代码。'
  if (source.length > 50000) return '图表超过 50000 字符，暂不渲染。请缩小图表后重试。'
  // 不接受文档覆盖渲染安全配置、活动 HTML 或外部图片／样式资源。
  if (/%%\s*\{|^\s*---|<[a-z!/]|url\s*\(|\b(?:img|image|icon)\s*:|(?:^|[;\n])\s*(?:style|classDef|linkStyle|click)\b/im.test(source)) return '暂不支持 Mermaid 配置指令、HTML 标签、交互命令或自定义图片／样式。请移除后重试。'
  return undefined
}

type BlockPreview = { image?: HTMLImageElement; active?: Preview }
type Preview = { source: string; theme?: string; version: number; due: number; block?: BlockPreview; host?: HTMLElement; message?: string; state?: string }
const EDIT_DELAY = 600
export function createMermaidPreview(root: HTMLElement) {
  const entries = new Map<string, Preview>()
  const blocks = new WeakMap<Element, BlockPreview>()
  let disposed = false, timer: ReturnType<typeof setTimeout> | undefined
  const getHost = (id: string) => root.querySelector<HTMLElement>(`[data-mermaid-preview="${id}"]`)
  const theme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default'
  const status = (host: HTMLElement, entry: Preview, message: string, state: string) => {
    entry.message = message; entry.state = state
    const image = entry.block?.image
    const text = document.createElement('span')
    text.className = 'mermaid-status'; text.textContent = message
    if (image) image.alt = state === 'ready' ? 'Mermaid 图表（图表代码见上方代码块）' : '上次成功渲染的 Mermaid 图表，当前代码尚未更新成功'
    host.replaceChildren(...(image ? [image, text] : [text]))
    host.dataset.state = state; host.setAttribute('aria-busy', String(state === 'pending'))
  }
  const schedule = () => {
    clearTimeout(timer)
    if (disposed) return
    const pending = [...entries.values()].filter(entry => entry.theme !== theme())
    if (pending.length) timer = setTimeout(refresh, Math.max(0, Math.min(...pending.map(entry => entry.due)) - Date.now()))
  }
  // Crepe 会清洗并克隆返回节点；在浏览器绘制前把已加载的旧图片移入新占位符。
  const synchronize = () => {
    if (disposed) return
    for (const [id, entry] of entries) {
      const host = getHost(id)
      if (!host) { if (entry.block || Date.now() >= entry.due) { entry.version++; entries.delete(id) }; continue }
      if (entry.block) {
        if (entry.host !== host) { entry.host = host; status(host, entry, entry.message ?? '', entry.state ?? 'pending') }
        continue
      }
      const container = host.closest('.milkdown-code-block') ?? host
      let block = blocks.get(container)
      if (!block) { block = {}; blocks.set(container, block) }
      if (block.active) block.active.version++
      block.active = entry; entry.block = block; entry.host = host
      status(host, entry, block.image ? '图表待更新（显示上次结果）' : '正在准备 Mermaid 图表…', 'pending')
    }
    schedule()
  }
  const refresh = () => {
    if (disposed) return
    for (const [id, entry] of entries) {
      const host = getHost(id)
      if (!host) { entry.version++; entries.delete(id); continue }
      if (!entry.block || entry.theme === theme() || entry.due > Date.now()) continue
      entry.theme = theme()
      const version = ++entry.version, selectedTheme = entry.theme
      const error = mermaidSourceError(entry.source)
      if (error) { status(host, entry, error, 'error'); continue }
      const current = () => !disposed && entries.get(id) === entry && entry.version === version && entry.block?.active === entry && !!getHost(id)
      queue = queue.catch(() => {}).then(async () => {
        if (!current()) return
        try {
          const { default: mermaid } = await loadMermaid()
          if (!current()) return
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: selectedTheme === 'dark' ? 'dark' : 'default', maxTextSize: 50000, maxEdges: 500, suppressErrorRendering: true, fontFamily: 'system-ui, sans-serif', secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels'] })
          const { svg } = await mermaid.render(id, entry.source)
          if (!current()) return
          const image = document.createElement('img')
          const viewBox = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement.getAttribute('viewBox')?.split(/[ ,]+/).map(Number)
          const width = viewBox?.[2]
          if (width && Number.isFinite(width) && width > 0) image.style.width = `${Math.ceil(width)}px`
          image.alt = 'Mermaid 图表（图表代码见上方代码块）'
          image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
          image.dataset.theme = selectedTheme
          await image.decode()
          if (!current()) return
          entry.block!.image = image
          const host = getHost(id)!
          status(host, entry, '', 'ready')
        } catch (error) {
          if (!current()) return
          status(getHost(id)!, entry, `Mermaid 渲染失败，代码已保留。请编辑代码后重试：${error instanceof Error ? error.message.slice(0, 500) : '未知错误'}`, 'error')
        } finally {
          document.getElementById(`d${id}`)?.remove()
        }
      })
    }
    schedule()
  }
  const observer = new MutationObserver(synchronize)
  observer.observe(root, { childList: true, subtree: true })
  const themeObserver = new MutationObserver(() => {
    for (const [id, entry] of entries) {
      entry.version++; entry.theme = undefined; entry.due = Math.max(entry.due, Date.now() + 120)
      const host = getHost(id)
      if (host) status(host, entry, entry.block?.image ? '图表待更新（显示上次结果）' : '正在准备 Mermaid 图表…', 'pending')
    }
    schedule()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return {
    render: (language: string, content: string) => {
      if (language.trim().toLowerCase() !== 'mermaid') return null
      const id = `folio-mermaid-${crypto.randomUUID()}`
      entries.set(id, { source: content, version: 0, due: Date.now() + EDIT_DELAY })
      const host = document.createElement('div')
      host.className = 'mermaid-preview'; host.dataset.mermaidPreview = id
      host.setAttribute('role', 'group'); host.setAttribute('aria-label', 'Mermaid 图表预览'); host.tabIndex = 0
      host.textContent = '正在准备 Mermaid 图表…'
      schedule()
      return host
    },
    destroy: () => { disposed = true; clearTimeout(timer); observer.disconnect(); themeObserver.disconnect(); entries.clear() },
  }
}
