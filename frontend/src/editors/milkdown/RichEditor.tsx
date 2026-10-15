import { useEffect, useRef, useState } from 'react'
import type { Session, WorkspaceSessions } from '../../sessions/workspace'
import type { CrepeBridge } from './bridge'
import { createCrepe, equivalentSource } from './engine'

export default function RichEditor({ session, sessions, onBlocked, bridge }: {
  session: Session; sessions: WorkspaceSessions; onBlocked: (reason: string) => void; bridge?: CrepeBridge
}) {
  const host = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const root = document.createElement('div')
    root.style.visibility = 'hidden'
    host.current!.append(root)
    let disposed = false
    let accepted = false
    const editor = createCrepe(root, session.source,
      (source) => { if (accepted && !disposed) sessions.update(session.path, source) },
      (message) => onBlocked(message ?? '示例模式不提供文件上传和导航，请使用标准 Markdown 源码。'),
      bridge ? { ...bridge, attached: () => !disposed && accepted } : undefined)
    const created = editor.create().then(async () => {
      if (disposed) return
      if (!equivalentSource(session.source, editor.getMarkdown())) {
        onBlocked('此文档经富文本转换后会发生变化。已保留完整原文，请使用源码编辑。')
        sessions.setMode(session.path, 'source')
        return
      }
      accepted = true
      root.style.visibility = ''
      setReady(true)
    }).catch((error: unknown) => {
      if (!disposed) {
        onBlocked(`富文本编辑器加载失败，原文已保留：${error instanceof Error ? error.message : '未知错误'}`)
        sessions.setMode(session.path, 'source')
      }
    })
    return () => {
      disposed = true
      // 每次挂载使用独立宿主，异步创建完成后仍会销毁，避免旧实例污染新文件。
      void created.then(() => editor.destroy()).catch(console.error).finally(() => root.remove())
    }
  }, [session, sessions, onBlocked, bridge])
  return <div className="rich-host" ref={host} aria-busy={!ready}>
    {!ready && <div className="editor-loading" role="status">正在检查 Markdown 兼容性…</div>}
  </div>
}
