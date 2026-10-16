import { formatBytes } from './format'

export type UploadLimits = { image: number; pdf: number; attachment: number }

// 与服务端一致：扩展名与实际文件头均参与分类，不依赖浏览器提供的 MIME。
export async function uploadLimit(file: File, limits: UploadLimits, imageOnly: boolean) {
  const bytes = new Uint8Array(await file.slice(0, 512).arrayBuffer())
  const prefix = String.fromCharCode(...bytes)
  const image = /\.(png|jpe?g|gif|webp)$/i.test(file.name) || prefix.startsWith('\x89PNG\r\n\x1a\n') || prefix.startsWith('\xff\xd8\xff') || /^GIF8[79]a/.test(prefix) || (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP')
  const pdf = /\.pdf$/i.test(file.name) || prefix.startsWith('%PDF-')
  const limit = Math.min(limits.attachment, image || imageOnly ? limits.image : Infinity, pdf ? limits.pdf : Infinity)
  return { limit, kind: image || imageOnly ? '图片' : pdf ? 'PDF' : '附件' }
}

export function uploadSizeMessage(name: string, size: number, kind: string, limit: number) {
  return `「${name}」为 ${formatBytes(size)}，超过${kind}上传上限 ${formatBytes(limit)}，请选择更小的文件或联系管理员调整限制。`
}
