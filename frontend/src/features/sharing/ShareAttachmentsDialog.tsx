import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { DialogContent } from '../../components/ui/dialog-content'
import { workspace } from '../../sessions/current'
import { formatBytes } from '../../services/format'
import { shares } from './api'
import type { Selection } from './api'

export function ShareAttachmentsDialog({ root, selected, onClose, onConfirm }: {
 root: string
 selected: string[] | null
 onClose: () => void
 onConfirm: (files: Selection[], selected: string[]) => void
}) {
 const [draft, setDraft] = useState<string[] | null>(null)
 const analysis = useQuery({
  queryKey: ['share-attachments', root], gcTime: 0, refetchOnWindowFocus: false, retry: false,
  queryFn: async () => {
   for (const session of workspace.list()) if (!(await workspace.flush(session.path))) throw new Error('有文件未保存、存在冲突或上传未完成，请返回工作区处理后再分享。')
   return shares.analyze(root, true)
  },
 })
 const files = analysis.data?.files ?? []
 // 新建时默认选中候选；重新打开时保留已确认的白名单，不自动公开新增引用。
 const chosen = files.filter(file => file.path === root || (draft ?? selected ?? files.map(item => item.path)).includes(file.path)).map(file => file.path)
 return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay share-attachments-overlay" /><DialogContent className="dialog-content share-dialog share-attachments-dialog">
  <Dialog.Title>选择附件</Dialog.Title>
  <Dialog.Description>选择随 Markdown 一起分享的本地文件。包含附件时使用快照。</Dialog.Description>
  <p className="share-attachment-root" title={root}>{root}</p>
  {analysis.isFetching && <p role="status">正在分析本地引用…</p>}
  {analysis.error && <p className="form-error" role="alert">{analysis.error.message}<Button onClick={() => void analysis.refetch()}>重试</Button></p>}
  {analysis.data && <><fieldset className="share-file-list"><legend>确认公开文件（{chosen.length} 个）</legend>{files.map(file => <label key={file.path}><input type="checkbox" checked={chosen.includes(file.path)} disabled={file.path === root || analysis.isFetching} onChange={event => setDraft(event.target.checked ? [...chosen, file.path] : chosen.filter(path => path !== file.path))} /><span>{file.path}</span><small>{formatBytes(file.metadata?.size ?? 0)}</small></label>)}</fieldset>
   {files.length === 1 && <p className="small-label">没有找到可分享的本地附件。</p>}
   {analysis.data.warnings.length > 0 && <div className="share-warnings" role="status"><p>以下引用不会包含：</p>{analysis.data.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
  </>}
  <div className="dialog-actions"><Button onClick={onClose}>取消</Button><Button className="share-confirm" disabled={!analysis.data || analysis.isFetching || !!analysis.error} onClick={() => onConfirm(files, chosen)}>确认选择</Button></div>
  <Button className="dialog-close" size="icon" aria-label="关闭附件选择" onClick={onClose}><X size={16}/></Button>
 </DialogContent></Dialog.Portal></Dialog.Root>
}
