export type ImageSize = { width: number; height: number }
export type ImageTransform = { scale: number; x: number; y: number }

export function fitImage(size: ImageSize, viewport: ImageSize): ImageTransform {
  const dimensions = [size.width, size.height, viewport.width, viewport.height]
  if (dimensions.some(value => !Number.isFinite(value) || value <= 0)) {
    return { scale: 1, x: 0, y: 0 }
  }
  return {
    scale: Math.min(1, viewport.width / size.width, viewport.height / size.height),
    x: 0,
    y: 0,
  }
}

export function zoomImage(
  current: ImageTransform,
  nextScale: number,
  anchor: { x: number; y: number },
  minScale = 0.01,
  maxScale = 8,
): ImageTransform {
  if (!Number.isFinite(nextScale) || !Number.isFinite(current.scale) || current.scale <= 0) {
    return { ...current }
  }
  const scale = Math.min(maxScale, Math.max(minScale, nextScale))
  const ratio = scale / current.scale
  return {
    scale,
    x: anchor.x - (anchor.x - current.x) * ratio,
    y: anchor.y - (anchor.y - current.y) * ratio,
  }
}
