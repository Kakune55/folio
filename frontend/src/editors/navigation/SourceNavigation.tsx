import { useEffect, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { sourceHeadings } from './headings'

export function SourceNavigation({ view, markdown }: { view: EditorView; markdown: boolean }) {
  const [headings, setHeadings] = useState<ReturnType<typeof sourceHeadings>>([])
  const [position, setPosition] = useState({ line: 1, lines: view.state.doc.lines })
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const jump = (ratio: number) => {
    const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, Math.round(ratio * (view.state.doc.lines - 1)) + 1)))
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
    view.focus()
  }
  useEffect(() => {
    let previous = view.state.doc
    let initialized = false
    let timer: ReturnType<typeof setTimeout>
    let frame = 0
    let drawingKey = ''
    const updateViewport = () => {
      frame = 0
      const next = { line: view.state.doc.lineAt(view.state.selection.main.head).number, lines: view.state.doc.lines }
      setPosition((current) => current.line === next.line && current.lines === next.lines ? current : next)
      const element = canvas.current, overlay = viewport.current
      if (!element || !overlay) return
      const spacing = Math.min(4, element.clientHeight / next.lines)
      const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop
      const first = view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, top)).from).number - 1
      const last = view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, top + view.scrollDOM.clientHeight)).to).number
      const height = Math.min(element.clientHeight, Math.max(12, (last - first) * spacing))
      overlay.style.height = `${height}px`
      overlay.style.transform = `translateY(${Math.max(0, Math.min(first * spacing, element.clientHeight - height))}px)`
    }
    const scheduleViewport = () => { if (!frame) frame = requestAnimationFrame(updateViewport) }
    const refresh = () => {
      const changed = !initialized || previous !== view.state.doc
      initialized = true; previous = view.state.doc
      if (markdown) {
        if (changed) setHeadings(sourceHeadings(view.state.doc.toString()))
        return
      }
      const element = canvas.current
      if (!element) return
      const width = element.clientWidth, height = element.clientHeight
      // 抽象图形无需高分辨率字形；限制画布分辨率，避免高 DPR 放大内存。
      const scale = Math.min(2, window.devicePixelRatio || 1)
      const color = getComputedStyle(element).getPropertyValue('--muted-foreground')
      const key = `${width}:${height}:${scale}:${color}`
      if (changed || drawingKey !== key) {
        drawingKey = key
        element.width = width * scale; element.height = height * scale
        const context = element.getContext('2d')
        if (context) {
          context.scale(scale, scale)
          context.fillStyle = color
          context.globalAlpha = .65
          const doc = view.state.doc, spacing = Math.min(4, height / doc.lines)
          const step = Math.max(1, Math.ceil(doc.lines / Math.max(1, height / 3)))
          // 采样数受面板高度约束；每行仅读取前 100 字符，不扫描全文或语法树。
          for (let n = 1; n <= doc.lines; n += step) {
            const line = doc.line(n)
            const text = doc.sliceString(line.from, Math.min(line.to, line.from + 100)).replace(/\t/g, '    ').slice(0, 100)
            const indent = text.search(/\S/)
            if (indent < 0) continue
            const unit = Math.max(0, width - 8) / 100
            const length = Math.max(2, text.trimEnd().length - indent)
            context.fillRect(4 + indent * unit, (n - 1) * spacing + 1, Math.min(width - 4 - (4 + indent * unit), length * unit), 1.5)
          }
        }
      }
      scheduleViewport()
    }
    const schedule = () => {
      scheduleViewport()
      if (!initialized || previous !== view.state.doc) { clearTimeout(timer); timer = setTimeout(refresh, 120) }
    }
    const scheduleDrawing = () => { clearTimeout(timer); timer = setTimeout(refresh, 120) }
    refresh()
    view.dom.addEventListener('folio-navigation', schedule)
    view.scrollDOM.addEventListener('scroll', scheduleViewport)
    const resize = new ResizeObserver(scheduleDrawing)
    if (panel.current) resize.observe(panel.current)
    const theme = new MutationObserver(scheduleDrawing)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      clearTimeout(timer); cancelAnimationFrame(frame); resize.disconnect(); theme.disconnect()
      view.dom.removeEventListener('folio-navigation', schedule)
      view.scrollDOM.removeEventListener('scroll', scheduleViewport)
    }
  }, [view, markdown])
  return <aside ref={panel} className={`document-navigation ${markdown ? '' : 'minimap-navigation'}`} aria-label={markdown ? 'Markdown 大纲' : '文本缩略图'}><div className="navigation-title">{markdown ? '大纲' : '缩略图'}</div>{markdown ? <nav aria-label="标题导航">{headings.length ? headings.map((heading) => <button key={heading.from} style={{ paddingInlineStart: 12 + (heading.level - 1) * 12 }} title={heading.text} onClick={() => {
    view.dispatch({ selection: { anchor: heading.from }, effects: EditorView.scrollIntoView(heading.from, { y: 'start' }) }); view.focus()
  }}>{heading.text}</button>) : <p>当前文档没有标题</p>}</nav> : <div className="minimap-surface"><div ref={viewport} className="minimap-viewport" aria-hidden="true" /><canvas ref={canvas} tabIndex={0} role="slider" aria-label="文本位置" aria-valuemin={1} aria-valuemax={position.lines} aria-valuenow={position.line} onPointerDown={(event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const spacing = Math.min(4, rect.height / view.state.doc.lines)
    jump((event.clientY - rect.top) / (view.state.doc.lines * spacing))
  }} onKeyDown={(event) => {
    const current = view.state.doc.lineAt(view.state.selection.main.head).number
    const target = event.key === 'Home' ? 1 : event.key === 'End' ? view.state.doc.lines : event.key === 'ArrowDown' ? current + 1 : event.key === 'ArrowUp' ? current - 1 : undefined
    if (target !== undefined) { event.preventDefault(); jump((target - 1) / Math.max(1, view.state.doc.lines - 1)); event.currentTarget.focus() }
  }} /></div>}</aside>
}

