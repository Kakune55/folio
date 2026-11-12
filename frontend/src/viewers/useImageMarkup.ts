import { useRef, useState } from 'react'
import { hitAnnotation, makeAnnotation, snap45, type Annotation, type AnnotationTool, type Point } from './image-annotations'

export type ImageTool = AnnotationTool | 'pan' | 'eraser'
type History = { past: Annotation[][]; present: Annotation[]; future: Annotation[][] }
type Gesture = { pointer: number; start: Point; last: Point; shift: boolean; raw: Point[]; annotation?: Annotation; erased?: Annotation[]; radius: number }
const MAX_MARKS = 200, MAX_POINTS = 50000, MAX_STROKE = 2000

export function useImageMarkup() {
  const [tool, setTool] = useState<ImageTool>('pan')
  const [penColor, setPenColor] = useState('#ef4444'), [markerColor, setMarkerColor] = useState('#facc15')
  const [penWidth, setPenWidth] = useState(6), [markerWidth, setMarkerWidth] = useState(24)
  const [history, setHistory] = useState<History>({ past: [], present: [], future: [] })
  const current = useRef(history), nextId = useRef(1), gesture = useRef<Gesture | undefined>(undefined)
  const [preview, setPreview] = useState<{ annotation?: Annotation; erased?: Annotation[] }>({})
  const [error, setError] = useState('')
  const color = tool === 'highlighter' ? markerColor : penColor, width = tool === 'highlighter' ? markerWidth : penWidth
  const apply = (next: History) => { current.current = next; setHistory(next) }
  const commit = (present: Annotation[]) => {
    const previous = current.current
    if (present.length === previous.present.length && present.every((mark, index) => mark === previous.present[index])) return
    const past = [...previous.past, previous.present].slice(-30)
    const retained = () => {
      const marks = new Set([...past.flat(), ...present])
      return [...marks].reduce((sum, mark) => sum + mark.points.length, 0)
    }
    while (past.length && retained() > 100000) past.shift()
    apply({ past, present, future: [] })
  }
  const cancel = () => { gesture.current = undefined; setPreview({}) }
  const undo = () => {
    cancel(); const value = current.current
    if (!value.past.length) return
    apply({ past: value.past.slice(0, -1), present: value.past.at(-1)!, future: [value.present, ...value.future] }); setError('')
  }
  const redo = () => {
    cancel(); const value = current.current
    if (!value.future.length) return
    apply({ past: [...value.past, value.present], present: value.future[0], future: value.future.slice(1) }); setError('')
  }
  const update = (point: Point, shift: boolean, final = false) => {
    const value = gesture.current
    if (!value) return
    if (value.erased) {
      value.erased = value.erased.filter(mark => !hitAnnotation(mark, point, value.radius, value.last))
      value.last = point; setPreview({ erased: value.erased }); return
    }
    const annotation = value.annotation!, distance = Math.hypot(point.x - value.last.x, point.y - value.last.y)
    if (shift === value.shift && (final ? distance === 0 : distance < 0.5)) return
    const freehand = annotation.tool === 'pen' || annotation.tool === 'highlighter'
    const raw = freehand ? distance > 0 ? [...value.raw, point] : value.raw : [value.start, point]
    const remaining = MAX_POINTS - current.current.present.reduce((sum, mark) => sum + mark.points.length, 0)
    if (raw.length > Math.min(MAX_STROKE, remaining)) { setError('本笔已达到点数限制，请抬笔后继续，或擦除部分标注。'); return }
    value.last = point; value.shift = shift; value.raw = raw
    let end = point
    if (shift && annotation.tool === 'rectangle') {
      const extent = Math.max(Math.abs(point.x - value.start.x), Math.abs(point.y - value.start.y))
      end = { x: value.start.x + (point.x < value.start.x ? -extent : extent), y: value.start.y + (point.y < value.start.y ? -extent : extent) }
    } else if (shift) end = snap45(value.start, point)
    value.annotation = makeAnnotation(annotation.id, annotation.tool, annotation.color, annotation.width, freehand && !shift ? raw : [value.start, end])
    setPreview({ annotation: value.annotation })
  }
  return {
    tool, color, width, error, annotations: history.present, rendered: preview.erased ?? history.present, draft: preview.annotation,
    canUndo: history.past.length > 0, canRedo: history.future.length > 0,
    selectTool(next: ImageTool) { cancel(); setTool(next); setError('') },
    setColor(value: string) { if (/^#[0-9a-f]{6}$/i.test(value)) { if (tool === 'highlighter') setMarkerColor(value); else setPenColor(value) } },
    setWidth(value: number) { if (Number.isFinite(value) && value >= 2 && value <= 48) { if (tool === 'highlighter') setMarkerWidth(value); else setPenWidth(value) } },
    begin(point: Point, pointer: number, radius: number, shift = false) {
      if (tool === 'pan') return false
      setError('')
      if (tool === 'eraser') {
        const erased = current.current.present.filter(mark => !hitAnnotation(mark, point, radius))
        gesture.current = { pointer, start: point, last: point, shift, raw: [point], erased, radius }; setPreview({ erased }); return true
      }
      if (current.current.present.length >= MAX_MARKS || current.current.present.reduce((sum, mark) => sum + mark.points.length, 0) >= MAX_POINTS) {
        setError('临时标注已达上限，请擦除或清空部分标注后继续。'); return false
      }
      const annotation = makeAnnotation(nextId.current++, tool, color, width, [point])
      gesture.current = { pointer, start: point, last: point, shift, raw: [point], annotation, radius }; setPreview({ annotation }); return true
    },
    update,
    updateShift(shift: boolean) { const value = gesture.current; if (value?.annotation) update(value.last, shift) },
    finish(pointer: number, canceled: boolean) {
      const value = gesture.current
      if (!value || value.pointer !== pointer) return
      gesture.current = undefined; setPreview({})
      if (canceled) return
      if (value.erased) commit(value.erased)
      else if (value.annotation && (['pen', 'highlighter'].includes(value.annotation.tool) || Math.hypot(value.annotation.points.at(-1)!.x - value.start.x, value.annotation.points.at(-1)!.y - value.start.y) >= 1)) commit([...current.current.present, value.annotation])
    },
    isDrawing: () => !!gesture.current,
    undo, redo, cancel,
    clear() { cancel(); commit([]); setError('') },
    reset() { cancel(); apply({ past: [], present: [], future: [] }); setError('') },
    snapshot: () => [...current.current.present],
  }
}
