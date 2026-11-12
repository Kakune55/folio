import { afterEach, describe, expect, it, vi } from 'vitest'
import { annotationExportError, exportAnnotatedImage, hitAnnotation, makeAnnotation, pointerToImage, snap45, type AnnotationTool } from './image-annotations'

const point = (x: number, y: number) => ({ x, y })
const mark = (tool: AnnotationTool = 'pen', points = [point(0, 0), point(100, 0)], width = 4) => makeAnnotation(1, tool, '#12AbEF', width, points)

describe('图片标注模型与路径', () => {
  it.each(['pen', 'highlighter'] as const)('%s 保留折线，单点生成可用圆端点描边', tool => {
    expect(mark(tool, [point(1, 2), point(3, 4), point(5, 6)]).path).toBe('M 1 2 L 3 4 L 5 6')
    expect(mark(tool, [point(1, 2)]).path).toBe('M 1 2 L 1 2')
  })

  it('直线只取首尾，矩形闭合且不含填充路径', () => {
    const points = [point(8, 9), point(100, 200), point(-2, -3)]
    expect(mark('line', points).path).toBe('M 8 9 L -2 -3')
    expect(mark('rectangle', points).path).toBe('M 8 9 L -2 9 L -2 -3 L 8 -3 L 8 9 Z')
    expect(mark('arrow', [point(2, 3)]).path).toBe('M 2 3 L 2 3')
  })

  it('箭头包含独立的双翼，短箭头翼长不超过箭身', () => {
    const arrow = mark('arrow')
    expect(arrow.path).toBe(`M 0 0 L 100 0 M ${100 - 12 * Math.cos(Math.PI / 6)} ${-12 * Math.sin(Math.PI / 6)} L 100 0 L ${100 - 12 * Math.cos(-Math.PI / 6)} ${-12 * Math.sin(-Math.PI / 6)}`)
    expect(mark('arrow', [point(0, 0), point(1, 0)]).path).not.toMatch(/NaN|Infinity/)
  })

  it.each(['red', '#fff', '#12345678', '#gggggg', 'url(x)', ' #123456'])('拒绝非法颜色 %s', color => {
    expect(() => makeAnnotation(1, 'pen', color, 4, [point(0, 0)])).toThrow(/颜色/)
  })

  it.each([0, -1, 257, NaN, Infinity, -Infinity])('拒绝非法笔宽 %s', width => {
    expect(() => mark('pen', [point(0, 0)], width)).toThrow(/笔宽/)
  })

  it('拒绝空点、非法工具、编号及任意非有限坐标', () => {
    expect(() => mark('pen', [])).toThrow(/至少/)
    expect(() => mark('eraser' as AnnotationTool)).toThrow(/工具/)
    expect(() => makeAnnotation(NaN, 'pen', '#123456', 4, [point(0, 0)])).toThrow(/编号/)
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => mark('line', [point(0, 0), point(value, 0), point(1, 1)])).toThrow(/坐标/)
      expect(() => mark('pen', [point(0, value)])).toThrow(/坐标/)
    }
    expect(mark('pen', [point(-1.5, 2.25)], 256).width).toBe(256)
  })

  it('拷贝点与数组，不改写调用方输入', () => {
    const points = Object.freeze([Object.freeze(point(1, 2)), Object.freeze(point(3, 4))])
    const result = makeAnnotation(9, 'pen', '#123456', 2, points)
    expect(result.points).toEqual(points)
    expect(result.points).not.toBe(points)
    expect(result.points[0]).not.toBe(points[0])
    result.points[0].x = 99
    expect(points[0].x).toBe(1)
  })
})

describe('吸附与坐标映射', () => {
  it.each(Array.from({ length: 8 }, (_, index) => index))('第 %s 个方向吸附 45 度且保持距离', index => {
    const angle = index * Math.PI / 4 + 0.1
    const start = Object.freeze(point(3, 7)), end = Object.freeze(point(3 + 20 * Math.cos(angle), 7 + 20 * Math.sin(angle)))
    const result = snap45(start, end)
    expect(result.x).toBeCloseTo(3 + 20 * Math.cos(index * Math.PI / 4))
    expect(result.y).toBeCloseTo(7 + 20 * Math.sin(index * Math.PI / 4))
    expect(Math.hypot(result.x - start.x, result.y - start.y)).toBeCloseTo(20)
  })

  it('同一点保持不动，无效坐标明确报错', () => {
    expect(snap45(point(2, 3), point(2, 3))).toEqual(point(2, 3))
    expect(() => snap45(point(NaN, 0), point(0, 0))).toThrow(/坐标/)
  })

  it('按画布中心、平移和缩放映射到原图，保留界外坐标', () => {
    const bounds = Object.freeze({ left: 10, top: 20, width: 800, height: 600 })
    const transform = Object.freeze({ scale: 0.5, x: 40, y: -20 })
    const size = Object.freeze({ width: 1000, height: 800 })
    expect(pointerToImage(point(450, 300), bounds, transform, size)).toEqual(point(500, 400))
    expect(pointerToImage(point(200, 100), bounds, transform, size)).toEqual(point(0, 0))
    expect(pointerToImage(point(100, 50), bounds, transform, size)).toEqual(point(-200, -100))
    expect(transform).toEqual({ scale: 0.5, x: 40, y: -20 })
  })

  it.each([0, -1, NaN, Infinity])('拒绝无效变换参数 %s', value => {
    expect(() => pointerToImage(point(0, 0), { left: 0, top: 0, width: 100, height: 100 }, { scale: value, x: 0, y: 0 }, { width: 100, height: 100 })).toThrow(/变换/)
  })
})

describe('整笔擦除几何', () => {
  it('计入笔宽与橡皮半径，并处理端点、单点、折线和重复点', () => {
    expect(hitAnnotation(mark(), point(50, 5), 3)).toBe(true)
    expect(hitAnnotation(mark(), point(50, 5.01), 3)).toBe(false)
    expect(hitAnnotation(mark(), point(-2, 0), 0)).toBe(true)
    expect(hitAnnotation(mark('pen', [point(10, 10)]), point(13, 10), 1)).toBe(true)
    expect(hitAnnotation(mark('highlighter', [point(0, 0), point(0, 0), point(0, 100)]), point(2, 80), 0)).toBe(true)
  })

  it('箭头翼可命中，矩形内部不命中，四条边均可命中', () => {
    expect(hitAnnotation(mark('arrow', undefined, 10), point(100 - 30 * Math.cos(Math.PI / 6), -15), 0)).toBe(true)
    expect(hitAnnotation(mark('line', undefined, 10), point(100 - 30 * Math.cos(Math.PI / 6), -15), 0)).toBe(false)
    const rectangle = mark('rectangle', [point(100, 100), point(0, 0)])
    expect(hitAnnotation(rectangle, point(50, 50), 1)).toBe(false)
    for (const p of [point(0, 50), point(100, 50), point(50, 0), point(50, 100)]) expect(hitAnnotation(rectangle, p, 0)).toBe(true)
  })

  it('扫过线段可穿越命中，不误判平行、共线分离或延长线', () => {
    const line = Object.freeze(mark('line'))
    expect(hitAnnotation(line, point(50, 100), 0, point(50, -100))).toBe(true)
    expect(hitAnnotation(line, point(150, 100), 0, point(150, -100))).toBe(false)
    expect(hitAnnotation(line, point(100, 10), 1, point(0, 10))).toBe(false)
    expect(hitAnnotation(line, point(300, 0), 0, point(200, 0))).toBe(false)
    expect(hitAnnotation(line, point(150, 0), 0, point(50, 0))).toBe(true)
    expect(hitAnnotation(mark('pen', [point(50, 50)]), point(100, 50), 0, point(0, 50))).toBe(true)
    expect(hitAnnotation(mark('rectangle', [point(0, 0), point(100, 100)]), point(200, 50), 0, point(-100, 50))).toBe(true)
    expect(hitAnnotation(mark('arrow'), point(100, -5), 0, point(85, -5))).toBe(true)
    expect(hitAnnotation(mark('line'), point(100, -5), 0, point(85, -5))).toBe(false)
    expect(line.points).toEqual([point(0, 0), point(100, 0)])
  })

  it('拒绝无效橡皮坐标和半径', () => {
    for (const radius of [-1, NaN, Infinity]) expect(() => hitAnnotation(mark(), point(0, 0), radius)).toThrow(/半径/)
    expect(() => hitAnnotation(mark(), point(NaN, 0), 1)).toThrow(/坐标/)
    expect(() => hitAnnotation(mark(), point(0, 0), 1, point(0, Infinity))).toThrow(/坐标/)
  })
})

describe('PNG 尺寸预算', () => {
  it.each([[4096, 4096], [8192, 2048], [2048, 8192], [1, 1]])('允许边界 %s × %s', (width, height) => {
    expect(annotationExportError({ width, height })).toBeUndefined()
  })
  it.each([[8193, 1], [1, 8193], [4096, 4097], [8192, 2049]])('拒绝超限 %s × %s', (width, height) => {
    expect(annotationExportError({ width, height })).toMatch(/不能超过/)
  })
  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])('拒绝非法尺寸 %s', value => {
    expect(annotationExportError({ width: value, height: 1 })).toMatch(/尺寸无效/)
    expect(annotationExportError({ width: 1, height: value })).toMatch(/尺寸无效/)
  })
})

describe('PNG 导出（最小 DOM stub）', () => {
  afterEach(() => vi.unstubAllGlobals())

  function setup() {
    const blob = new Blob(['png'], { type: 'image/png' })
    const drawn: { path: string; alpha: number; color: string; width: number }[] = []
    const ctx = {
      drawImage: vi.fn(), lineCap: '', lineJoin: '', globalAlpha: 1, strokeStyle: '', lineWidth: 1,
      stroke: vi.fn((path: { path: string }) => drawn.push({ path: path.path, alpha: ctx.globalAlpha, color: ctx.strokeStyle, width: ctx.lineWidth })),
    }
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => ctx), toBlob: vi.fn((callback: BlobCallback, _type: string) => callback(blob)) }
    const createElement = vi.fn(() => canvas)
    vi.stubGlobal('document', { createElement })
    vi.stubGlobal('Path2D', class {
      path: string
      constructor(path: string) { this.path = path }
    })
    const image = Object.freeze({ complete: true, naturalWidth: 100, naturalHeight: 80 }) as HTMLImageElement
    return { blob, drawn, ctx, canvas, createElement, image }
  }

  it('原图先绘制，按顺序描边并分别设置透明度，只返回 PNG Blob 且释放画布', async () => {
    const { image, canvas, ctx, drawn, blob, createElement } = setup()
    const marks = Object.freeze([Object.freeze(mark('highlighter')), Object.freeze(mark('pen')), Object.freeze(mark('rectangle'))])
    expect(await exportAnnotatedImage(image, marks)).toBe(blob)
    expect(createElement).toHaveBeenCalledExactlyOnceWith('canvas')
    expect(ctx.drawImage).toHaveBeenCalledExactlyOnceWith(image, 0, 0)
    expect(ctx.drawImage.mock.invocationCallOrder[0]).toBeLessThan(ctx.stroke.mock.invocationCallOrder[0])
    expect(drawn).toEqual(marks.map(mark => ({ path: mark.path, alpha: mark.tool === 'highlighter' ? 0.28 : 1, color: mark.color, width: mark.width })))
    expect(ctx.lineCap).toBe('round')
    expect(ctx.lineJoin).toBe('round')
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png')
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(image.naturalWidth).toBe(100)
    expect(marks[0].tool).toBe('highlighter')
  })

  it('未就绪或超预算时不分配画布', async () => {
    const { image, createElement } = setup()
    await expect(exportAnnotatedImage({ ...image, complete: false } as HTMLImageElement, [])).rejects.toThrow(/尚未加载/)
    await expect(exportAnnotatedImage({ ...image, naturalWidth: 0 } as HTMLImageElement, [])).rejects.toThrow(/尚未加载/)
    await expect(exportAnnotatedImage({ ...image, naturalWidth: 8193 } as HTMLImageElement, [])).rejects.toThrow(/8192/)
    await expect(exportAnnotatedImage({ ...image, naturalWidth: 4096, naturalHeight: 4097 } as HTMLImageElement, [])).rejects.toThrow(/16777216/)
    expect(createElement).not.toHaveBeenCalled()
  })

  it('不接受与模型不一致的路径，不分配画布', async () => {
    const { image, createElement } = setup()
    await expect(exportAnnotatedImage(image, [{ ...mark(), path: 'M 0 0' }])).rejects.toThrow(/路径/)
    expect(createElement).not.toHaveBeenCalled()
  })

  it.each(['context', 'draw', 'path', 'null', 'encode', 'taint', 'allocation'])('%s 失败明确报错并释放画布', async failure => {
    const { image, canvas, ctx, createElement } = setup()
    if (failure === 'context') canvas.getContext.mockReturnValue(null as unknown as typeof ctx)
    if (failure === 'draw') ctx.drawImage.mockImplementation(() => { throw new RangeError('memory') })
    if (failure === 'path') vi.stubGlobal('Path2D', class { constructor() { throw new Error('path') } })
    if (failure === 'null') canvas.toBlob.mockImplementation(callback => callback(null))
    if (failure === 'encode') canvas.toBlob.mockImplementation(() => { throw new Error('encoding') })
    if (failure === 'taint') canvas.toBlob.mockImplementation(() => { throw new DOMException('tainted', 'SecurityError') })
    if (failure === 'allocation') createElement.mockImplementation(() => { throw new RangeError('memory') })
    await expect(exportAnnotatedImage(image, [mark()])).rejects.toThrow(failure === 'taint' ? /跨域安全/ : /内存|导出/)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })

  it('等待异步编码完成后才释放画布，空标注仍可导出原始像素', async () => {
    const { image, canvas, ctx, blob } = setup()
    let finish: BlobCallback | undefined
    canvas.toBlob.mockImplementation(callback => { finish = callback })
    const pending = exportAnnotatedImage(image, [])
    expect(canvas.width).toBe(100)
    expect(canvas.height).toBe(80)
    expect(ctx.stroke).not.toHaveBeenCalled()
    finish!(blob)
    expect(await pending).toBe(blob)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })
})
