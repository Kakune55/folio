import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { Button } from '../components/ui/button'
import { fileURL } from '../services/api'
import type { FileMetadata } from '../services/api'

GlobalWorkerOptions.workerSrc = workerURL
export default function PdfViewer({ metadata }: { metadata: FileMetadata }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy>()
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const [rendering, setRendering] = useState(true)
  useEffect(() => {
    let disposed = false
    const loading = getDocument({ url: fileURL(metadata.path, true), withCredentials: true, disableFontFace: true, useSystemFonts: true, useWasm: false, enableXfa: false, stopAtErrors: true, maxImageSize: 8_000_000, canvasMaxAreaInBytes: 32_000_000 })
    void loading.promise.then((value) => { if (!disposed) setDocument(value) }).catch(() => { if (!disposed) { setError('PDF 无法预览，可能已加密、损坏或使用了尚不支持的字体/图像格式。请下载原文件查看。'); setRendering(false) } })
    return () => { disposed = true; void loading.destroy().catch(console.error) }
  }, [metadata.path])
  useEffect(() => {
    if (!document || !canvas.current) return
    let disposed = false
    let task: RenderTask | undefined
    setRendering(true)
    void document.getPage(page).then(async (pdfPage) => {
      if (disposed) return
      const base = pdfPage.getViewport({ scale: 1 })
      const scale = Math.min(1.6, 1200 / base.width, Math.sqrt(8_000_000 / (base.width * base.height)))
      const viewport = pdfPage.getViewport({ scale })
      canvas.current!.width = Math.ceil(viewport.width); canvas.current!.height = Math.ceil(viewport.height)
      task = pdfPage.render({ canvas: canvas.current!, viewport })
      await task.promise
      if (!disposed) setRendering(false)
    }).catch(() => { if (!disposed) { setError('此页渲染失败，请下载原文件查看。'); setRendering(false) } })
    return () => { disposed = true; task?.cancel() }
  }, [document, page])
  return <div className="pdf-viewer"><div className="pdf-toolbar"><Button disabled={!document || page <= 1 || rendering} onClick={() => setPage(page - 1)}>上一页</Button><span>{document ? `${page} / ${document.numPages}` : 'PDF'}</span><Button disabled={!document || page >= document.numPages || rendering} onClick={() => setPage(page + 1)}>下一页</Button><a className="button button-outline" href={fileURL(metadata.path)} download>下载原文件</a></div>
    <p className="pdf-hint">预览可能省略不受支持的字体或大图，请下载原文件核对。</p>
    {error && <p className="notice" role="alert">{error}</p>}{rendering && <p className="editor-loading" role="status">正在渲染 PDF…</p>}
    <canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} role="img" hidden={!!error} />
  </div>
}
