import { describe, expect, expectTypeOf, it } from 'vitest'
import { fitImage, zoomImage, type ImageSize, type ImageTransform } from './image-transform'

describe('图片适配', () => {
  it.each([
    [200, 100, 800, 600, 1],
    [800, 600, 800, 600, 1],
    [1600, 400, 800, 600, 0.5],
    [400, 2400, 800, 600, 0.25],
    [1600, 1200, 800, 600, 0.5],
    [1600, 1200, 600, 800, 0.375],
  ])('图片 %s×%s 适配 %s×%s 且不放大小图', (width, height, vw, vh, scale) => {
    expect(fitImage({ width, height }, { width: vw, height: vh })).toEqual({ scale, x: 0, y: 0 })
  })

  it.each([0, -1, NaN, Infinity, -Infinity])('任意尺寸无效时返回单位变换：%s', value => {
    for (const field of ['width', 'height'] as const) {
      expect(fitImage({ width: 100, height: 100, [field]: value }, { width: 800, height: 600 }))
        .toEqual({ scale: 1, x: 0, y: 0 })
      expect(fitImage({ width: 100, height: 100 }, { width: 800, height: 600, [field]: value }))
        .toEqual({ scale: 1, x: 0, y: 0 })
    }
  })
})

describe('图片缩放', () => {
  it('以画布中心缩放时保持居中', () => {
    expect(zoomImage({ scale: 1, x: 0, y: 0 }, 2, { x: 0, y: 0 }))
      .toEqual({ scale: 2, x: 0, y: 0 })
  })

  it('以鼠标位置缩放时保持其下图片点不动', () => {
    expect(zoomImage({ scale: 1, x: 0, y: 0 }, 2, { x: 100, y: -50 }))
      .toEqual({ scale: 2, x: -100, y: 50 })
  })

  it.each([0.25, 1, 3])('平移后缩放至 %s 仍保持锚点', scale => {
    const current = { scale: 0.5, x: 80, y: -30 }
    const anchor = { x: -120, y: 70 }
    const result = zoomImage(current, scale, anchor)
    expect((anchor.x - result.x) / result.scale).toBeCloseTo((anchor.x - current.x) / current.scale)
    expect((anchor.y - result.y) / result.scale).toBeCloseTo((anchor.y - current.y) / current.scale)
  })

  it.each([[-2, 0.01], [0, 0.01], [0.001, 0.01], [0.01, 0.01], [8, 8], [20, 8]])(
    '目标比例 %s 使用夹取后的 %s 计算位移',
    (nextScale, scale) => {
      const result = zoomImage({ scale: 1, x: 20, y: -10 }, nextScale, { x: 100, y: 50 })
      expect(result).toEqual({ scale, x: 100 - 80 * scale, y: 50 - 60 * scale })
    },
  )

  it('支持低于 1% 的适配比例与自定义上限', () => {
    const current = fitImage({ width: 200000, height: 100000 }, { width: 800, height: 600 })
    expect(current.scale).toBe(0.004)
    expect(zoomImage(current, 0.001, { x: 0, y: 0 }, Math.min(current.scale, 0.01)))
      .toEqual(current)
    expect(zoomImage(current, 4, { x: 0, y: 0 }, 0.004, 2).scale).toBe(2)
  })

  it.each([NaN, Infinity, -Infinity])('忽略非有限目标比例：%s', nextScale => {
    const current = { scale: 0.5, x: 20, y: -10 }
    expect(zoomImage(current, nextScale, { x: 100, y: 50 })).toEqual(current)
  })

  it.each([0, -1, NaN, Infinity, -Infinity])('无效旧比例不参与除法：%s', scale => {
    const current = { scale, x: 20, y: -10 }
    expect(zoomImage(current, 2, { x: 100, y: 50 })).toEqual(current)
  })

  it('类型符合公开 API 且不修改输入', () => {
    const size: ImageSize = Object.freeze({ width: 1600, height: 1200 })
    const viewport: ImageSize = Object.freeze({ width: 800, height: 600 })
    const current: ImageTransform = Object.freeze({ scale: 0.5, x: 20, y: -10 })
    const anchor = Object.freeze({ x: 100, y: 50 })
    expectTypeOf(fitImage(size, viewport)).toEqualTypeOf<ImageTransform>()
    expectTypeOf(zoomImage(current, 2, anchor)).toEqualTypeOf<ImageTransform>()
    expect(size).toEqual({ width: 1600, height: 1200 })
    expect(viewport).toEqual({ width: 800, height: 600 })
    expect(current).toEqual({ scale: 0.5, x: 20, y: -10 })
    expect(anchor).toEqual({ x: 100, y: 50 })
  })
})
