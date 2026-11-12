import { lazy, Suspense, useState } from 'react'
import { ArrowDownToLine, FileArchive, ImageOff } from 'lucide-react'
import type { FileMetadata } from '../services/api'
import { fileURL } from '../services/api'
import { ImagePreviewDialog } from './ImagePreviewDialog'
import { Button } from '../components/ui/button'
const PdfViewer = lazy(() => import('./PdfViewer'))

export default function AttachmentViewer({ metadata }: { metadata: FileMetadata }) {
  const [imageFailed, setImageFailed] = useState(false)
  const [imageOpen, setImageOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const label = metadata.path.split('/').at(-1) || '工作区图片'
  const download = <a className="button button-outline" href={fileURL(metadata.path)} download><ArrowDownToLine size={15} />下载文件</a>
  if (metadata.viewer === 'pdf') return <Suspense fallback={<p className="editor-loading" role="status">正在加载 PDF 查看器…</p>}><PdfViewer metadata={metadata} /></Suspense>
  if (metadata.viewer === 'image' && !imageFailed) return <div className="image-viewer"><button type="button" className="image-open" aria-label={`放大图片：${label}`} onClick={() => setImageOpen(true)}><img key={attempt} src={fileURL(metadata.path, true)} alt={label} onError={() => setImageFailed(true)} /></button><div className="viewer-caption">{Math.ceil(metadata.size / 1024)} KiB · {metadata.mediaType} {download}</div><ImagePreviewDialog key={imageOpen ? metadata.path : 'closed'} image={imageOpen ? { url: fileURL(metadata.path, true), downloadURL: fileURL(metadata.path), label } : undefined} onClose={() => setImageOpen(false)} /></div>
  return <div className="empty-workspace">{imageFailed ? <ImageOff size={30} /> : <FileArchive size={30} />}<h1>{imageFailed ? '图片暂时无法预览' : '此类型提供下载'}</h1><p>{label} · {Math.ceil(metadata.size / 1024)} KiB<br />{imageFailed ? '可能是登录过期、文件已变更或图片不受支持。' : '原始文件'}</p>{imageFailed && <Button variant="outline" onClick={() => { setImageFailed(false); setImageOpen(false); setAttempt(value => value + 1) }}>重试图片</Button>}{download}</div>
}
