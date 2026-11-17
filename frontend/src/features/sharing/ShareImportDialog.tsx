import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '../../components/ui/button'
import { DialogContent } from '../../components/ui/dialog-content'
import { DirectoryPicker } from '../explorer/DirectoryPicker'
import type { Principal } from '../../services/api'
import type { ShareFile } from './api'
import { notify } from '../../stores/notifications'

export function ShareImportDialog({ shareId, file, includeAttachments, principal, onClose }: {
  shareId: string
  file: ShareFile
  includeAttachments: boolean
  principal: Principal
  onClose: () => void
}) {
  const client = useQueryClient()
  const [directory, setDirectory] = useState('')
  const [name, setName] = useState(() => `分享-${Date.now()}`)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  const validName = !!name.trim() && name !== '.' && name !== '..' && name.toLowerCase() !== '.folio' && !/[/\\]/.test(name) && !Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  const destination = directory ? `${directory}/${name}` : name
  const close = () => { if (!running.current) onClose() }

  return <Dialog.Root open onOpenChange={(value) => { if (!value) close() }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content share-import-dialog">
    <Dialog.Title>保存到我的工作区</Dialog.Title>
    <Dialog.Description>{includeAttachments ? '主文件与分享内附件一起保存' : '仅保存当前文件'}，保留包内路径，不覆盖同名文件夹。</Dialog.Description>
    <p className="operation-selection" title={file.path}>{file.path.split('/').at(-1)}</p>
    <form onSubmit={async (event) => {
      event.preventDefault()
      if (running.current || blocked || !ready || !validName) return
      running.current = true; setBusy(true); setError('')
      try {
        const response = await fetch(`/api/v1/shares/${shareId}/import`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': principal.csrfToken, 'X-Folio-Workspace': principal.workspaceId },
          body: JSON.stringify({ file: file.id, directory: destination }),
        })
        const result = await response.json()
        if (!response.ok) {
          if (response.status >= 500 || result.error?.code === 'durability_uncertain') throw new TypeError('转存结果未知')
          if (response.status === 401 || result.error?.code === 'workspace_changed') setBlocked(true)
          throw new Error(result.error?.message ?? '转存失败，请检查目标目录后重试')
        }
        if (typeof result.path !== 'string' || result.path !== destination) throw new TypeError('转存结果未知')
        void client.invalidateQueries({ queryKey: ['tree'] })
        void client.invalidateQueries({ queryKey: ['usage'] })
        void client.invalidateQueries({ queryKey: ['move-directories'] })
        onClose()
        notify.success(`已保存到我的工作区：${result.path}。这是独立副本。`)
      } catch (problem) {
        if (problem instanceof TypeError || problem instanceof SyntaxError) {
          setBlocked(true)
          setError(`转存结果尚未确认，请先检查「${destination}」是否已创建。关闭窗口并核对后，再重新发起转存，不要直接重复提交。`)
        } else setError(problem instanceof Error ? problem.message : '转存失败，请检查目标目录后重试')
      } finally { running.current = false; setBusy(false) }
    }}>
      <DirectoryPicker directory={directory} entries={[]} workspaceId={principal.workspaceId} disabled={busy || blocked} onReadyChange={setReady} onChange={(path) => {
        if (!running.current && !blocked && path !== directory) { setReady(false); setDirectory(path); setError('') }
      }} />
      <label htmlFor="import-folder-name">副本文件夹名称</label>
      <input id="import-folder-name" value={name} disabled={busy || blocked} maxLength={255} required aria-invalid={!validName} aria-describedby="import-destination" onChange={(event) => { setName(event.target.value); setError('') }} />
      <p id="import-destination" className="share-import-destination">{validName ? `保存至：工作区 / ${destination}` : '请输入单个文件夹名称，不能包含路径分隔符或使用系统保留名称。'}</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="dialog-actions"><Button type="button" disabled={busy} onClick={close}>{blocked ? '关闭' : '取消'}</Button><Button type="submit" variant="outline" disabled={busy || blocked || !ready || !validName}>{busy ? '正在转存…' : '确认转存'}</Button></div>
    </form>
  </DialogContent></Dialog.Portal></Dialog.Root>
}
