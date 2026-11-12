import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowDownToLine, Minus, Plus, X } from 'lucide-react'
import { DialogContent } from '../components/ui/dialog-content'
import { Button } from '../components/ui/button'
import './image-preview.css'
import { fitImage, zoomImage, type ImageSize, type ImageTransform } from './image-transform'
import { annotationExportError, exportAnnotatedImage, pointerToImage } from './image-annotations'
import { useImageMarkup } from './useImageMarkup'
import { ImageAnnotationLayer, ImageMarkupControls } from './ImageMarkupControls'

export type ImagePreviewFile = { url: string; downloadURL: string; label: string }

export function ImagePreviewDialog({ image, onClose }: { image?: ImagePreviewFile; onClose: () => void }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [size, setSize] = useState<ImageSize>()
  const [viewport, setViewport] = useState<ImageSize>({ width: 0, height: 0 })
  const [transform, setTransform] = useState<ImageTransform>({ scale: 1, x: 0, y: 0 })
  const [mode, setMode] = useState<'fit' | 'original' | 'free'>('fit')
  const [dragging, setDragging] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const markup = useImageMarkup()
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState('')
  const sourceImage = useRef<HTMLImageElement>(null), tools = useRef<HTMLDivElement>(null), alive = useRef(true)
  const stage = useRef<HTMLDivElement>(null), header = useRef<HTMLDivElement>(null), toolbar = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const moved = useRef(false), background = useRef(false), dismiss = useRef(false), start = useRef({ x: 0, y: 0 })
  const panGesture = useRef(true), drawing = useRef(false)
  const annotationError = size ? annotationExportError(size) : undefined
  const canMark = phase === 'ready' && !annotationError
  const activeTool = canMark ? markup.tool : 'pan'
  const fit = size ? fitImage(size, viewport) : { scale: 1, x: 0, y: 0 }
  const minScale = Math.min(0.01, fit.scale)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useLayoutEffect(() => {
    const canvas = stage.current
    if (!canvas || !size) return
    const measure = () => {
      const box = canvas.getBoundingClientRect()
      const edge = Math.max((header.current?.offsetHeight ?? 0) + 16, (toolbar.current?.offsetHeight ?? 0) + 32)
      const rail = tools.current && getComputedStyle(tools.current).position === 'fixed' ? tools.current.offsetWidth + 32 : 24
      const available = { width: Math.max(1, box.width - rail * 2), height: Math.max(1, box.height - edge * 2) }
      setViewport(previous => previous.width === available.width && previous.height === available.height ? previous : available)
      if (mode === 'fit') setTransform(fitImage(size, available))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    if (header.current) observer.observe(header.current)
    if (toolbar.current) observer.observe(toolbar.current)
    if (tools.current) observer.observe(tools.current)
    return () => observer.disconnect()
  }, [size, mode, image?.url])
  useEffect(() => {
    const canvas = stage.current
    if (!canvas || !size || phase !== 'ready') return
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return
      event.preventDefault()
      if (drawing.current) return
      const box = canvas.getBoundingClientRect(), unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1
      const delta = Math.max(-1000, Math.min(1000, event.deltaY * unit))
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.012 : 0.0015))
      const anchor = { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 }
      setMode('free'); setTransform(value => zoomImage(value, value.scale * factor, anchor, Math.min(0.01, fitImage(size, viewport).scale)))
    }
    // React 的 wheel 监听可能为被动监听；画布必须阻止页面滚动和浏览器整页缩放。
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => canvas.removeEventListener('wheel', wheel)
  }, [phase, size, viewport, image?.url])
  const reset = (original = false) => {
    setMode(original ? 'original' : 'fit')
    setTransform(original ? { scale: 1, x: 0, y: 0 } : fit)
  }
  const zoom = (factor: number) => {
    setMode('free'); setTransform(value => zoomImage(value, value.scale * factor, { x: 0, y: 0 }, minScale))
  }
  const gesture = () => {
    const [first, second] = [...pointers.current.values()]
    return { x: second ? (first.x + second.x) / 2 : first.x, y: second ? (first.y + second.y) / 2 : first.y, distance: second ? Math.hypot(second.x - first.x, second.y - first.y) : 0 }
  }
  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>, canceled = false) => {
    if (!pointers.current.has(event.pointerId)) return
    if (!canceled && size && markup.isDrawing()) markup.update(pointerToImage({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), transform, size), event.shiftKey, true)
    markup.finish(event.pointerId, canceled); drawing.current = markup.isDrawing()
    if (!pointers.current.delete(event.pointerId)) return
    if (pointers.current.size === 0) { setDragging(false); dismiss.current = !canceled && background.current && !moved.current }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const exportImage = async () => {
    if (!sourceImage.current || !canMark || exporting || markup.isDrawing()) return
    const marks = markup.snapshot()
    if (!marks.length) return
    setExporting(true); setExportError('')
    try {
      const blob = await exportAnnotatedImage(sourceImage.current, marks)
      if (!alive.current) return
      const url = URL.createObjectURL(blob), anchor = document.createElement('a')
      const name = [...(image?.label || '图片')].map(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127 || /[\\/:*?"<>|]/.test(character) ? '_' : character).join('').slice(0, 80).replace(/\.(?:png|jpe?g|gif|webp)$/i, '') || '图片'
      anchor.href = url; anchor.download = `${name}-标注.png`
      document.body.append(anchor); anchor.click(); anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { if (alive.current) setExportError(error instanceof Error ? error.message : '图片导出失败，请重试或下载原图。') }
    finally { if (alive.current) setExporting(false) }
  }
  if (!image) return null
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="image-preview-overlay" />
    <DialogContent className="image-preview-dialog" onOpenAutoFocus={event => { event.preventDefault(); stage.current?.focus() }} onKeyDown={event => {
      if (event.key === 'Shift' && markup.isDrawing()) { markup.updateShift(true); return }
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) markup.redo(); else markup.undo(); drawing.current = false }
      else if (event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopPropagation(); markup.redo(); drawing.current = false }
    }} onKeyUp={event => { if (event.key === 'Shift' && markup.isDrawing()) markup.updateShift(false) }}>
      <div className="image-preview-heading" ref={header}><div><Dialog.Title>图片预览</Dialog.Title><Dialog.Description className="image-preview-label">{image.label || '工作区图片'}</Dialog.Description></div><Dialog.Close asChild><Button size="icon" aria-label="关闭图片预览"><X size={20} /></Button></Dialog.Close></div>
      <div className="image-preview-stage" ref={stage} tabIndex={0} role="region" aria-label="图片缩放画布" aria-description="移动工具可拖拽平移，滚轮或双指缩放。选择画笔可临时标注，Shift 按 45 度吸附。方向键移动，+ 和 - 缩放，0 适应窗口，1 原始尺寸。" data-tool={activeTool} data-mode={mode} data-scale={transform.scale} data-x={transform.x} data-y={transform.y} data-dragging={dragging} aria-busy={phase === 'loading'}
        onPointerDown={event => {
          if (phase !== 'ready' || event.button !== 0 || pointers.current.size >= 2) return
          event.preventDefault(); event.currentTarget.focus({ preventScroll: true })
          if (!pointers.current.size) {
            moved.current = false; dismiss.current = false; background.current = activeTool === 'pan' && event.target === event.currentTarget; start.current = { x: event.clientX, y: event.clientY }
            panGesture.current = activeTool === 'pan'
            if (!panGesture.current && size) {
              const point = pointerToImage({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), transform, size)
              if (point.x >= 0 && point.y >= 0 && point.x <= size.width && point.y <= size.height) markup.begin(point, event.pointerId, Math.max(8 / transform.scale, markup.width / 2), event.shiftKey)
              drawing.current = markup.isDrawing(); moved.current = true
            }
          } else { moved.current = true; panGesture.current = true; markup.cancel(); drawing.current = false }
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true)
        }}
        onPointerMove={event => {
          if (!pointers.current.has(event.pointerId) || phase !== 'ready') return
          if (markup.isDrawing() && size) {
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
            const box = event.currentTarget.getBoundingClientRect(), samples = event.nativeEvent.getCoalescedEvents?.() ?? []
            for (const sample of samples.length ? samples : [event.nativeEvent]) markup.update(pointerToImage({ x: sample.clientX, y: sample.clientY }, box, transform, size), sample.shiftKey)
            return
          }
          if (!panGesture.current) { pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); return }
          const before = gesture()
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          const after = gesture(), box = event.currentTarget.getBoundingClientRect()
          const dx = after.x - before.x, dy = after.y - before.y
          if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 3) moved.current = true
          setMode('free')
          setTransform(value => {
            const translated = { ...value, x: value.x + dx, y: value.y + dy }
            return before.distance > 0 && after.distance > 0 ? zoomImage(translated, value.scale * after.distance / before.distance, { x: after.x - box.left - box.width / 2, y: after.y - box.top - box.height / 2 }, minScale) : translated
          })
        }}
        onPointerUp={event => finishPointer(event)} onPointerCancel={event => finishPointer(event, true)} onLostPointerCapture={event => finishPointer(event, true)}
        onClick={event => { if (event.target === event.currentTarget && (phase !== 'ready' || dismiss.current)) { dismiss.current = false; onClose() } }}
        onDoubleClick={event => {
          if (phase !== 'ready' || activeTool !== 'pan' || background.current) return
          if (Math.abs(transform.scale - 1) < 0.001) reset()
          else {
            const box = event.currentTarget.getBoundingClientRect()
            setMode('free'); setTransform(value => zoomImage(value, 1, { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 }, minScale))
          }
        }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || phase !== 'ready' || markup.isDrawing()) return
          if (event.key === '+' || event.key === '=') zoom(1.25)
          else if (event.key === '-') zoom(0.8)
          else if (event.key === '0' || event.key === 'Home') reset()
          else if (event.key === '1') reset(true)
          else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            const step = event.shiftKey ? 100 : 40
            setMode('free'); setTransform(value => ({ ...value, x: value.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), y: value.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }))
          } else return
          event.preventDefault()
        }}>
        {phase === 'loading' && <p role="status">正在加载图片…</p>}
        {phase === 'error' && <div className="image-preview-error"><p role="alert">图片无法加载，可能是登录过期、文件已变更或格式不受支持。原文未修改，可重试或下载原图。{markup.annotations.length > 0 && '重新加载会清空本次临时标注。'}</p><Button variant="outline" onClick={() => { markup.reset(); drawing.current = false; setExportError(''); setPhase('loading'); setSize(undefined); setMode('fit'); setTransform({ scale: 1, x: 0, y: 0 }); setAttempt(value => value + 1) }}>重试加载图片</Button></div>}
        <div className="image-preview-surface" style={{ width: size?.width, height: size?.height, transform: `translate(-50%, -50%) translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}>
          <img key={attempt} ref={sourceImage} src={image.url} alt={image.label || '工作区图片'} hidden={phase !== 'ready'} draggable={false} onDragStart={event => event.preventDefault()}
            onLoad={event => { if (!event.currentTarget.isConnected) return; const dimensions = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; setSize(dimensions); if (annotationExportError(dimensions)) markup.selectTool('pan'); setPhase('ready') }}
            onError={event => { if (event.currentTarget.isConnected) { markup.cancel(); drawing.current = false; pointers.current.clear(); setDragging(false); setSize(undefined); setPhase('error') } }} />
          {size && canMark && <ImageAnnotationLayer size={size} marks={markup.rendered} draft={markup.draft} />}
        </div>
      </div>
      <div className="image-preview-toolbar" ref={toolbar}>
        <ImageMarkupControls markup={markup} disabled={!canMark} toolsRef={tools} />
        <div className="image-preview-actions" role="group" aria-label="图片查看控制">
          <Button size="icon" aria-label="缩小图片" disabled={phase !== 'ready' || transform.scale <= minScale} onClick={() => zoom(0.8)}><Minus size={17} /></Button>
          <output aria-label="缩放比例" aria-live="off">{phase === 'ready' ? `${Math.round(transform.scale * 1000) / 10}%` : '—'}</output>
          <Button size="icon" aria-label="放大图片" disabled={phase !== 'ready' || transform.scale >= 8} onClick={() => zoom(1.25)}><Plus size={17} /></Button>
          <Button aria-pressed={mode === 'fit'} disabled={phase !== 'ready'} onClick={() => reset()}>适应窗口</Button>
          <Button aria-pressed={mode === 'original'} disabled={phase !== 'ready'} onClick={() => reset(true)}>原始尺寸</Button>
          <a className="button" href={image.downloadURL} download><ArrowDownToLine size={15} />下载原图</a>
          <Button className="image-export-button" disabled={!canMark || !markup.annotations.length || exporting} onClick={() => { void exportImage() }}><ArrowDownToLine size={15} />{exporting ? '正在导出' : '导出标注'}</Button>
          <span className="image-preview-dimensions">{size ? `${size.width} × ${size.height} 像素` : ''}</span>
        </div>
        {(annotationError || markup.error || exportError) && <p className="image-markup-error" role="alert">{exportError || markup.error || annotationError}</p>}
        <p className="image-preview-hint">{activeTool === 'pan' ? '拖拽移动 · 滚轮或双指缩放' : 'Shift 45° 对齐 · 矩形按 Shift 为正方形'} · 标注仅临时，关闭直接丢弃</p>
      </div>
    </DialogContent>
  </Dialog.Portal></Dialog.Root>
}
