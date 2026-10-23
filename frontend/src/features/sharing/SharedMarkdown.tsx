import { useEffect, useRef, useState } from 'react'
import { createMermaidPreview } from '../../editors/milkdown/mermaid-preview'
import { Button } from '../../components/ui/button'

export default function SharedMarkdown({ html }: { html: string }) {
 const root = useRef<HTMLDivElement>(null)
 const [imageError, setImageError] = useState(false)
 useEffect(() => {
  if (!root.current) return
  const preview = createMermaidPreview(root.current)
  const hosts: HTMLElement[] = []
  for (const code of root.current.querySelectorAll('pre > code.language-mermaid')) {
   const host = preview.render('mermaid', code.textContent ?? '')
   if (host instanceof HTMLElement) {code.parentElement!.after(host);hosts.push(host)}
  }
  return () => {preview.destroy();hosts.forEach(host => host.remove())}
 }, [html])
 // 仅接收后端 Goldmark 默认安全渲染产物；不接收用户提供的原始 HTML。
 return <>{imageError && <p role="alert">部分图片加载失败，分享可能已失效或服务繁忙。<Button onClick={() => {setImageError(false);for (const image of root.current?.querySelectorAll('img') ?? []) {if (!image.naturalWidth && image.src.startsWith(window.location.origin)) {const url = new URL(image.src);url.searchParams.set('retry', String(Date.now()));image.src = url.href}}}}>重试图片</Button></p>}<article ref={root} className="shared-markdown" onErrorCapture={event => {if (event.target instanceof HTMLImageElement && !event.target.src.startsWith('data:')) setImageError(true)}} dangerouslySetInnerHTML={{ __html: html }} /></>
}
