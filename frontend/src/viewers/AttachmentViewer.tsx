import { lazy, Suspense, useState } from 'react'
import { ArrowDownToLine, FileArchive, ImageOff } from 'lucide-react'
import type { FileMetadata } from '../services/api'
import { fileURL } from '../services/api'
const PdfViewer = lazy(() => import('./PdfViewer'))

export default function AttachmentViewer({ metadata }: { metadata: FileMetadata }) {
  const [imageFailed, setImageFailed] = useState(false)
  const download = <a className="button button-outline" href={fileURL(metadata.path)} download><ArrowDownToLine size={15} />下载文件</a>
  if (metadata.viewer === 'pdf') return <Suspense fallback={<p className="editor-loading" role="status">正在加载 PDF 查看器…</p>}><PdfViewer metadata={metadata} /></Suspense>
  if (metadata.viewer === 'image' && !imageFailed) return <div className="image-viewer"><img src={fileURL(metadata.path, true)} alt={metadata.path.split('/').at(-1)} onError={() => setImageFailed(true)} /><div className="viewer-caption">{Math.ceil(metadata.size / 1024)} KiB · {metadata.mediaType} {download}</div></div>
  return <div className="empty-workspace">{imageFailed ? <ImageOff size={30} /> : <FileArchive size={30} />}<h1>{imageFailed ? '图片暂时无法预览' : '此类型提供下载'}</h1><p>{metadata.path.split('/').at(-1)} · {Math.ceil(metadata.size / 1024)} KiB<br />{imageFailed ? '可能是登录过期、文件已变更或图片不受支持。' : '保留原始文件，不解压或执行文件内容。'}</p>{download}</div>
}
