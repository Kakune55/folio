import type { ImageSize, ImageTransform } from './image-transform'

export type Point = { x: number; y: number }
export type AnnotationTool = 'pen' | 'highlighter' | 'line' | 'arrow' | 'rectangle'
export type Annotation = {
  id: number
  tool: AnnotationTool
  color: string
  width: number
  points: Point[]
  path: string
}

function checkPoint(point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('标注坐标必须为有限数值。')
}

// 路径与擦除共用这些折线，避免箭头翼或矩形边缘与显示不一致。
function strokes(tool: AnnotationTool, points: readonly Point[], width: number): Point[][] {
  const start = points[0], end = points[points.length - 1]
  if (tool === 'pen' || tool === 'highlighter') return [points.length === 1 ? [start, start] : [...points]]
  if (tool === 'rectangle') return [[start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start]]
  if (tool === 'line') return [[start, end]]
  const distance = Math.hypot(end.x - start.x, end.y - start.y)
  if (!distance) return [[start, end]]
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const length = Math.min(distance, Math.max(12, width * 3))
  const wing = (offset: number) => ({ x: end.x - length * Math.cos(angle + offset), y: end.y - length * Math.sin(angle + offset) })
  return [[start, end], [wing(Math.PI / 6), end, wing(-Math.PI / 6)]]
}

export function makeAnnotation(id: number, tool: AnnotationTool, color: string, width: number, points: readonly Point[]): Annotation {
  if (!Number.isFinite(id)) throw new Error('标注编号必须为有限数值。')
  if (!['pen', 'highlighter', 'line', 'arrow', 'rectangle'].includes(tool)) throw new Error('不支持的标注工具。')
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('标注颜色必须为 #rrggbb 格式。')
  if (!Number.isFinite(width) || width <= 0 || width > 256) throw new Error('标注笔宽必须大于 0 且不超过 256。')
  if (!points.length) throw new Error('标注至少需要一个点。')
  points.forEach(checkPoint)
  const copy = points.map(point => ({ x: point.x, y: point.y }))
  const lines = strokes(tool, copy, width)
  lines.forEach(line => line.forEach(checkPoint))
  const path = lines.map(line => line.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')).join(' ')
    + (tool === 'rectangle' ? ' Z' : '')
  return { id, tool, color, width, points: copy, path }
}

export function snap45(start: Point, end: Point): Point {
  checkPoint(start); checkPoint(end)
  const dx = end.x - start.x, dy = end.y - start.y
  const distance = Math.hypot(dx, dy)
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  const result = { x: start.x + distance * Math.cos(angle), y: start.y + distance * Math.sin(angle) }
  checkPoint(result)
  return result
}

export function pointerToImage(
  client: Point,
  bounds: { left: number; top: number; width: number; height: number },
  transform: ImageTransform,
  size: ImageSize,
): Point {
  checkPoint(client)
  if (![bounds.left, bounds.top, bounds.width, bounds.height, transform.x, transform.y, transform.scale, size.width, size.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || transform.scale <= 0 || size.width <= 0 || size.height <= 0) {
    throw new Error('图片坐标变换参数无效。')
  }
  const result = {
    x: (client.x - bounds.left - bounds.width / 2 - transform.x) / transform.scale + size.width / 2,
    y: (client.y - bounds.top - bounds.height / 2 - transform.y) / transform.scale + size.height / 2,
  }
  checkPoint(result)
  return result
}

function pointSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x, dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (!length) return Math.hypot(point.x - start.x, point.y - start.y)
  const ux = dx / length, uy = dy / length
  const along = Math.max(0, Math.min(length, (point.x - start.x) * ux + (point.y - start.y) * uy))
  return Math.hypot(point.x - start.x - along * ux, point.y - start.y - along * uy)
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const abc = cross(a, b, c), abd = cross(a, b, d), cda = cross(c, d, a), cdb = cross(c, d, b)
  // 严格穿越在内部相交；共线或端点接触交由点到线段距离处理。
  if (((abc < 0 && abd > 0) || (abc > 0 && abd < 0)) && ((cda < 0 && cdb > 0) || (cda > 0 && cdb < 0))) return 0
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b))
}

export function hitAnnotation(annotation: Annotation, point: Point, radius: number, previous?: Point): boolean {
  checkPoint(point)
  if (previous) checkPoint(previous)
  if (!Number.isFinite(radius) || radius < 0) throw new Error('橡皮半径必须为非负有限数值。')
  const mark = makeAnnotation(annotation.id, annotation.tool, annotation.color, annotation.width, annotation.points)
  const reach = radius + mark.width / 2
  return strokes(mark.tool, mark.points, mark.width).some(line => line.slice(1).some((end, index) =>
    segmentDistance(previous ?? point, point, line[index], end) <= reach,
  ))
}

export function annotationExportError(size: ImageSize): string | undefined {
  if (![size.width, size.height].every(value => Number.isSafeInteger(value) && value > 0)) return '图片尺寸无效，无法导出 PNG。'
  if (size.width > 8192 || size.height > 8192) return '图片单边不能超过 8192 像素，无法导出 PNG。'
  if (size.width * size.height > 16777216) return '图片总像素不能超过 16777216，无法导出 PNG。'
  return undefined
}

export async function exportAnnotatedImage(image: HTMLImageElement, marks: readonly Annotation[]): Promise<Blob> {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error('图片尚未加载完成，无法导出 PNG。')
  const size = { width: image.naturalWidth, height: image.naturalHeight }
  const budgetError = annotationExportError(size)
  if (budgetError) throw new Error(budgetError)
  // 在分配画布前验证，并固定本次导出的标注快照。
  const snapshot = marks.map(mark => {
    const validated = makeAnnotation(mark.id, mark.tool, mark.color, mark.width, mark.points)
    if (validated.path !== mark.path) throw new Error('标注路径与几何数据不一致，无法导出 PNG。')
    return validated
  })
  let canvas: HTMLCanvasElement | undefined
  let failure = '无法创建图片导出画布'
  try {
    canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建图片导出画布，可能内存不足。')
    failure = '无法绘制原图'
    ctx.drawImage(image, 0, 0)
    failure = '无法绘制图片标注'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const mark of snapshot) {
      ctx.globalAlpha = mark.tool === 'highlighter' ? 0.28 : 1
      ctx.strokeStyle = mark.color
      ctx.lineWidth = mark.width
      ctx.stroke(new Path2D(mark.path))
    }
    failure = 'PNG 编码失败'
    return await new Promise<Blob>((resolve, reject) => {
      canvas!.toBlob(blob => {
        if (blob) resolve(blob)
        else reject(new Error('PNG 编码失败，可能内存不足，请减少图片尺寸后重试。'))
      }, 'image/png')
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'SecurityError') throw new Error('图片受跨域安全限制，无法导出 PNG。', { cause: error })
    throw new Error(`${failure}，可能内存不足或画布不可用，请重试。`, { cause: error })
  } finally {
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
  }
}
