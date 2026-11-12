import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowDownToLine, X } from 'lucide-react'
import { DialogContent } from '../components/ui/dialog-content'
import { Button } from '../components/ui/button'
import './image-preview.css'

export type ImagePreviewFile = { url: string; downloadURL: string; label: string }

export function ImagePreviewDialog({ image, onClose }: { image?: ImagePreviewFile; onClose: () => void }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [size, setSize] = useState<{ width: number; height: number }>()
  const [original, setOriginal] = useState(false)
  const [attempt, setAttempt] = useState(0)
  if (!image) return null
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <DialogContent className="dialog-content image-preview-dialog">
      <div className="image-preview-heading"><Dialog.Title>图片预览</Dialog.Title><Dialog.Close asChild><Button size="icon" aria-label="关闭图片预览"><X size={18} /></Button></Dialog.Close></div>
      <Dialog.Description className="image-preview-label">{image.label || '工作区图片'}</Dialog.Description>
      <div className="image-preview-toolbar">
        <Button variant="outline" aria-pressed={!original} disabled={phase !== 'ready'} onClick={() => setOriginal(false)}>适应窗口</Button>
        <Button variant="outline" aria-pressed={original} disabled={phase !== 'ready'} onClick={() => setOriginal(true)}>原始尺寸</Button>
        <a className="button button-outline" href={image.downloadURL} download><ArrowDownToLine size={15} />下载原图</a>
        <span className="image-preview-dimensions">{size ? `${size.width} × ${size.height} 像素` : ''}</span>
      </div>
      <div className="image-preview-stage" data-size={original ? 'original' : 'fit'} aria-busy={phase === 'loading'}>
        {phase === 'loading' && <p role="status">正在加载图片…</p>}
        {phase === 'error' && <div className="image-preview-error"><p role="alert">图片无法加载，可能是登录过期、文件已变更或格式不受支持。原文未修改，可重试或下载原图。</p><Button variant="outline" onClick={() => { setPhase('loading'); setSize(undefined); setOriginal(false); setAttempt(value => value + 1) }}>重试加载图片</Button></div>}
        <img key={attempt} src={image.url} alt={image.label || '工作区图片'} hidden={phase !== 'ready'} style={original && size ? { width: size.width, height: size.height } : undefined}
          onLoad={event => { if (!event.currentTarget.isConnected) return; setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setPhase('ready') }}
          onError={event => { if (event.currentTarget.isConnected) { setSize(undefined); setPhase('error') } }} />
      </div>
    </DialogContent>
  </Dialog.Portal></Dialog.Root>
}
