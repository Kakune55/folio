import { useEffect, useRef, useState } from 'react'
import type { Session, WorkspaceSessions } from '../../sessions/workspace'
import type { CrepeBridge } from './bridge'
import { createCrepe, equivalentSource } from './engine'
import * as Dialog from '@radix-ui/react-dialog'
import { DialogContent } from '../../components/ui/dialog-content'
import { Button } from '../../components/ui/button'
import { downloadDraft } from '../../services/api'
import { conversionDiff } from './conversion-diff'

export default function RichEditor({ session, sessions, onBlocked, bridge }: {
  session: Session; sessions: WorkspaceSessions; onBlocked: (reason: string) => void; bridge?: CrepeBridge
}) {
  const host = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [conversion, setConversion] = useState<{ original: string; converted: string; diff: string; accept: () => void }>()
  useEffect(() => {
    const original = session.source
    const root = document.createElement('div')
    root.style.visibility = 'hidden'
    host.current!.append(root)
    let disposed = false
    let accepted = false
    const editor = createCrepe(root, original,
      (source) => { if (accepted && !disposed) sessions.update(session.path, source) },
      (message) => onBlocked(message ?? '示例模式不提供文件上传和导航，请使用标准 Markdown 源码。'),
      bridge ? { ...bridge, attached: () => !disposed && accepted } : undefined)
    const created = editor.create().then(async () => {
      if (disposed) return
      if (session.source !== original) {
        onBlocked('检查期间原文已变化，当前原文已保留，请重新打开富文本预览。')
        sessions.setMode(session.path, 'source')
        return
      }
      const converted = editor.getMarkdown()
      if (!equivalentSource(original, converted)) {
        setConversion({ original, converted, diff: conversionDiff(original, converted), accept: () => {
          if (disposed) return
          if (session.source !== original || session.locked || !sessions.has(session.path) || sessions.get(session.path) !== session) {
            onBlocked('预览期间原文或文件状态已变化，请重新检查转换。当前原文已保留。')
            sessions.setMode(session.path, 'source')
            return
          }
          sessions.update(session.path, converted)
          accepted = true
          root.style.visibility = ''
          setReady(true)
          setConversion(undefined)
          onBlocked('已按确认结果转换为富文本；转换后的内容将按现有保存规则保存。切换模式会重置撤销历史。')
        } })
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
  const cancel = () => {
    onBlocked('此文档经富文本转换后会发生变化。已保留完整原文，请使用源码编辑。')
    sessions.setMode(session.path, 'source')
  }
  return <>
    <div className="rich-host" ref={host} aria-busy={!ready && !conversion}>
      {!ready && <div className="editor-loading" role="status">{conversion ? '等待确认转换，原文尚未更改。' : '正在检查 Markdown 兼容性…'}</div>}
    </div>
    <Dialog.Root open={!!conversion} onOpenChange={(open) => { if (!open) cancel() }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content conflict-dialog conversion-dialog" onOpenAutoFocus={(event) => { event.preventDefault(); document.getElementById('cancel-conversion')?.focus() }}>
      <Dialog.Title>富文本转换预览</Dialog.Title>
      <Dialog.Description>此文档转换后会发生变化，部分语法或内容可能丢失。预览不会修改原文；确认后会替换当前正文，并按现有规则自动保存。请先检查差异，必要时下载原文。切换模式会重置撤销历史。</Dialog.Description>
      <div className="compare-columns"><div><label htmlFor="conversion-original">转换前原文</label><textarea id="conversion-original" readOnly value={conversion?.original ?? ''} /></div><div><label htmlFor="conversion-result">转换后 Markdown</label><textarea id="conversion-result" readOnly value={conversion?.converted ?? ''} /></div></div>
      <details><summary>查看 Diff（- 原文 / + 转换后）</summary><p>展示首尾相同区域之间的完整替换区间，可能包含未变化的中间行。LF / CRLF / CR 为换行类型，EOF 表示末行无换行。</p><pre className="conversion-diff" tabIndex={0} aria-label="转换差异">{conversion?.diff}</pre></details>
      <div className="dialog-actions"><Button onClick={() => conversion && downloadDraft(session.path, conversion.original)}>下载转换前原文</Button><Button id="cancel-conversion" variant="outline" onClick={cancel}>保留原文，使用源码</Button><Button variant="outline" onClick={() => conversion?.accept()}>确认转换并编辑</Button></div>
    </DialogContent></Dialog.Portal></Dialog.Root>
  </>
}
