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
    const scroll = view.scrollDOM
    scroll.scrollTo({ top: Math.max(0, Math.min(1, ratio)) * Math.max(0, scroll.scrollHeight - scroll.clientHeight), behavior: 'instant' })
  }
  useEffect(() => {
    let previous = view.state.doc
    let initialized = false
    let timer: ReturnType<typeof setTimeout>
    let frame = 0
    let dragFrame = 0
    let drag: { id: number; offset: number; clientY: number } | undefined
    let drawingKey = ''
    const updateViewport = () => {
      frame = 0
      const scroll = view.scrollDOM
      const ratio = Math.max(0, Math.min(1, scroll.scrollTop / Math.max(1, scroll.scrollHeight - scroll.clientHeight)))
      const next = { line: Math.round(ratio * (view.state.doc.lines - 1)) + 1, lines: view.state.doc.lines }
      setPosition((current) => current.line === next.line && current.lines === next.lines ? current : next)
      const element = canvas.current, overlay = viewport.current
      if (!element || !overlay) return
      const contentHeight = Math.min(element.clientHeight, next.lines * 4)
      const height = Math.min(contentHeight, Math.max(12, contentHeight * scroll.clientHeight / Math.max(1, scroll.scrollHeight)))
      const travel = Math.max(0, contentHeight - height)
      overlay.style.height = `${height}px`
      overlay.style.transform = `translateY(${Math.max(0, Math.min(1, ratio)) * travel}px)`
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
    const applyDrag = () => {
      dragFrame = 0
      const element = canvas.current, overlay = viewport.current
      if (!drag || !element || !overlay) return
      const rect = element.getBoundingClientRect()
      const contentHeight = Math.min(rect.height, view.state.doc.lines * 4)
      const travel = Math.max(0, contentHeight - overlay.getBoundingClientRect().height)
      const ratio = travel > 0 ? Math.max(0, Math.min(1, (drag.clientY - rect.top - drag.offset) / travel)) : 0
      const scroll = view.scrollDOM
      // 只滚动原生容器，不改变光标或正文；每帧只应用最后一个指针位置。
      scroll.scrollTop = ratio * Math.max(0, scroll.scrollHeight - scroll.clientHeight)
      updateViewport()
    }
    const pointerDown = (event: PointerEvent) => {
      const element = canvas.current, overlay = viewport.current
      if (!element || !overlay || drag || !event.isPrimary || event.button !== 0) return
      event.preventDefault()
      updateViewport()
      const thumb = overlay.getBoundingClientRect()
      const inside = event.clientY >= thumb.top && event.clientY <= thumb.bottom
      drag = { id: event.pointerId, offset: inside ? event.clientY - thumb.top : thumb.height / 2, clientY: event.clientY }
      element.setPointerCapture(event.pointerId)
      element.focus({ preventScroll: true })
      element.style.cursor = 'grabbing'
      if (!inside) applyDrag()
    }
    const pointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return
      drag.clientY = event.clientY
      if (!dragFrame) dragFrame = requestAnimationFrame(applyDrag)
    }
    const finishDrag = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return
      cancelAnimationFrame(dragFrame)
      dragFrame = 0
      if (event.type === 'pointerup') { drag.clientY = event.clientY; applyDrag() }
      const id = drag.id
      drag = undefined
      const element = canvas.current
      if (element) {
        element.style.cursor = ''
        if (element.hasPointerCapture(id)) element.releasePointerCapture(id)
      }
    }
    refresh()
    const element = canvas.current
    element?.addEventListener('pointerdown', pointerDown)
    element?.addEventListener('pointermove', pointerMove)
    element?.addEventListener('pointerup', finishDrag)
    element?.addEventListener('pointercancel', finishDrag)
    element?.addEventListener('lostpointercapture', finishDrag)
    view.dom.addEventListener('folio-navigation', schedule)
    view.scrollDOM.addEventListener('scroll', scheduleViewport)
    const resize = new ResizeObserver(scheduleDrawing)
    if (panel.current) resize.observe(panel.current)
    const theme = new MutationObserver(scheduleDrawing)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      if (drag && element?.hasPointerCapture(drag.id)) element.releasePointerCapture(drag.id)
      drag = undefined
      if (element) element.style.cursor = ''
      element?.removeEventListener('pointerdown', pointerDown)
      element?.removeEventListener('pointermove', pointerMove)
      element?.removeEventListener('pointerup', finishDrag)
      element?.removeEventListener('pointercancel', finishDrag)
      element?.removeEventListener('lostpointercapture', finishDrag)
      clearTimeout(timer); cancelAnimationFrame(dragFrame); cancelAnimationFrame(frame); resize.disconnect(); theme.disconnect()
      view.dom.removeEventListener('folio-navigation', schedule)
      view.scrollDOM.removeEventListener('scroll', scheduleViewport)
    }
  }, [view, markdown])
  return <aside ref={panel} className={`document-navigation ${markdown ? '' : 'minimap-navigation'}`} aria-label={markdown ? 'Markdown 大纲' : '文本缩略图'}><div className="navigation-title">{markdown ? '大纲' : '缩略图'}</div>{markdown ? <nav aria-label="标题导航">{headings.length ? headings.map((heading) => <button key={heading.from} style={{ paddingInlineStart: 12 + (heading.level - 1) * 12 }} title={heading.text} onClick={() => {
    view.dispatch({ selection: { anchor: heading.from }, effects: EditorView.scrollIntoView(heading.from, { y: 'start' }) }); view.focus()
  }}>{heading.text}</button>) : <p>当前文档没有标题</p>}</nav> : <div className="minimap-surface"><div ref={viewport} className="minimap-viewport" aria-hidden="true" /><canvas ref={canvas} tabIndex={0} role="slider" aria-label="文本位置" aria-valuemin={1} aria-valuemax={position.lines} aria-valuenow={position.line} onKeyDown={(event) => {
    const current = position.line
    const target = event.key === 'Home' ? 1 : event.key === 'End' ? view.state.doc.lines : event.key === 'ArrowDown' ? current + 1 : event.key === 'ArrowUp' ? current - 1 : undefined
    if (target !== undefined) { event.preventDefault(); jump((target - 1) / Math.max(1, view.state.doc.lines - 1)); event.currentTarget.focus() }
  }} /></div>}</aside>
}

