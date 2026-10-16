import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '../../components/ui/button'
import { api, ApiError } from '../../services/api'
import type { Entry, EntryRevision } from '../../services/api'
import { workspace } from '../../sessions/current'
import type { Session } from '../../sessions/workspace'

export function useEntryOperations({ onRemap, onDelete, onNotice, uploading }: { onRemap: (from: string, to: string) => void; onDelete: (path: string) => void; onNotice: (message: string) => void; uploading: boolean }) {
  const client = useQueryClient()
  const [operation, setOperation] = useState<{ type: 'move' | 'delete'; entry: Entry }>()
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['tree'] }), client.invalidateQueries({ queryKey: ['trash'] })])
  const prepare = async (entry: Entry, affected: Session[]) => {
    for (const session of affected) if (!(await workspace.flush(session.path, true))) throw new Error('有修改或图片上传未能保存，已保留原路径和草稿。请先处理保存错误或冲突。')
    const revisions = new Map<string, EntryRevision>()
    for (const session of affected) {
      if (!session.revision) continue
      const current = await api.entryRevision(session.path); revisions.set(session.path, current)
      if (current.revision !== session.revision) throw new ApiError(412, 'revision_conflict', `「${session.path}」已被外部修改，请先比较版本再操作`)
    }
    return revisions.get(entry.path) ?? await api.entryRevision(entry.path)
  }
  const perform = async (entry: Entry, destination?: string) => {
    if (uploading) throw new Error('附件正在上传，请完成后再操作文件')
    if (destination && (destination === entry.path || destination.startsWith(`${entry.path}/`))) throw new Error('目标路径无效，不能把文件夹移入自身')
    if (destination && !workspace.canRemap(entry.path, destination)) throw new Error('目标路径已有编辑会话，请先保存并关闭该标签页')
    const affected = workspace.lockTree(entry.path, destination)
    let mutationStarted = false
    try {
      const revision = await prepare(entry, affected)
      mutationStarted = true
      if (destination) {
        await api.move(entry.path, destination, revision.revision)
        workspace.remap(entry.path, destination); onRemap(entry.path, destination)
        // 改变扩展名时重新分类；若二进制变为可编辑文本，必须先加载正文和版本。
        let typeRefreshFailed = false
        for (const session of affected) {
          try {
            const metadata = await api.metadata(session.path)
            if (['markdown', 'text'].includes(metadata.viewer) && !['markdown', 'text'].includes(session.viewer)) {
              const file = await api.read(session.path); workspace.acceptRemote(session.path, file.content, file.revision)
            }
            workspace.setMetadata(session.path, metadata)
          } catch { typeRefreshFailed = true }
        }
        onNotice(typeRefreshFailed ? '路径已更新，但文件类型刷新失败。当前草稿仍保留，请关闭并重新打开文件；相关 Markdown 链接需手动检查。' : '文件路径已更新。Markdown 链接不会自动改写，请检查相关引用。')
      } else {
        await api.trash(entry.path, revision.revision)
        for (const session of affected) workspace.remove(session.path, true)
        onDelete(entry.path); onNotice('已移到回收站，可从回收站恢复。')
      }
      await refresh()
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : '文件操作失败，请保留草稿并刷新列表确认'
      if (problem instanceof ApiError && [404, 412].includes(problem.status)) workspace.operationFailed(affected, message, true)
      else if (mutationStarted && (!(problem instanceof ApiError) || problem.status >= 500)) workspace.operationFailed(affected, message, false)
      onNotice(message); void refresh(); throw problem
    } finally { workspace.unlock(affected, [entry.path, ...(destination ? [destination] : [])]) }
  }
  return {
    dialogOpen: !!operation,
    moveToDirectory: async (entry: Entry, directory: string) => {
      const destination = directory ? `${directory}/${entry.name}` : entry.name
      await perform(entry, destination)
    },
    rename: async (entry: Entry, name: string) => {
      const parent = entry.path.split('/').slice(0, -1).join('/')
      await perform(entry, parent ? `${parent}/${name}` : name)
    },
    showMove: (entry: Entry) => { setError(''); setTarget(entry.path); setOperation({ type: 'move', entry }) },
    showDelete: (entry: Entry) => { setError(''); setOperation({ type: 'delete', entry }) },
    dialogs: <Dialog.Root open={!!operation} onOpenChange={(value) => { if (!value && !busy) setOperation(undefined) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content"><Dialog.Title>{operation?.type === 'delete' ? '移到回收站？' : '移动文件或文件夹'}</Dialog.Title><Dialog.Description>{operation?.type === 'delete' ? `「${operation.entry.path}」将移到回收站，保留可恢复副本。` : `当前位置：${operation?.entry.path ?? ''}。请输入完整的工作区相对目标路径；相关 Markdown 链接不会自动改写。`}</Dialog.Description>
      <form onSubmit={async (event) => {
        event.preventDefault(); if (!operation) return
        setBusy(true); setError('')
        try { await perform(operation.entry, operation.type === 'move' ? target : undefined); setOperation(undefined) }
        catch (problem) { setError(problem instanceof Error ? problem.message : '操作失败，草稿与恢复记录已保留') }
        finally { setBusy(false) }
      }}>{operation?.type === 'move' && <><label htmlFor="move-target">目标路径</label><input id="move-target" value={target} onChange={(event) => setTarget(event.target.value)} required autoFocus disabled={busy} /></>}
      {error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><Button type="button" onClick={() => setOperation(undefined)} disabled={busy}>取消</Button><Button type="submit" variant="outline" disabled={busy}>{busy ? '正在处理…' : operation?.type === 'delete' ? '移到回收站' : '移动'}</Button></div></form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>,
  }
}
