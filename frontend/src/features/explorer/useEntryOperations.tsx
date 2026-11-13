import { DialogContent } from '../../components/ui/dialog-content'
import { useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '../../components/ui/button'
import { api, ApiError } from '../../services/api'
import type { Entry, EntryRevision } from '../../services/api'
import { workspace } from '../../sessions/current'
import type { Session } from '../../sessions/workspace'
import { DirectoryPicker } from './DirectoryPicker'

type Operation = { type: 'move' | 'delete'; entries: Entry[]; total: number; completed: number; batch: boolean; blocked: boolean }
class UncertainOperationError extends Error {}
class EntryTypeChangedError extends Error {}

export function useEntryOperations({ onRemap, onDelete, onNotice, uploading }: { onRemap: (from: string, to: string) => void; onDelete: (path: string) => void; onNotice: (message: string) => void; uploading: boolean }) {
  const client = useQueryClient()
  const [operation, setOperation] = useState<Operation>()
  const [target, setTarget] = useState('')
  const [targetReady, setTargetReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['tree'] }), client.invalidateQueries({ queryKey: ['trash'] }), client.invalidateQueries({ queryKey: ['move-directories'] })])
  const prepare = async (entry: Entry, affected: Session[]) => {
    for (const session of affected) if (!(await workspace.flush(session.path, true))) throw new Error('有修改或图片上传未能保存，已保留原路径和草稿。请先处理保存错误或冲突。')
    const revisions = new Map<string, EntryRevision>()
    for (const session of affected) {
      if (!session.revision) continue
      const current = await api.entryRevision(session.path); revisions.set(session.path, current)
      if (current.revision !== session.revision) throw new ApiError(412, 'revision_conflict', `「${session.path}」已被外部修改，请先比较版本再操作`)
    }
    const current = revisions.get(entry.path) ?? await api.entryRevision(entry.path)
    if (current.kind !== entry.kind) throw new EntryTypeChangedError(`「${entry.path}」的文件／目录类型已变化，本次未操作该路径。请取消本次操作、刷新列表后重新选择。`)
    return current
  }
  const checkDestination = (entry: Entry, destination: string) => {
    if (!destination || destination.split('/').some((part) => !part || part === '.' || part === '..') || destination.includes('\\')) throw new Error('请输入有效的工作区相对目标路径')
    if (destination === entry.path || destination.startsWith(`${entry.path}/`)) throw new Error('目标路径无效，不能移动到原路径或把文件夹移入自身')
    if (!workspace.canRemap(entry.path, destination) || workspace.list().some((session) => session.path === destination || session.path.startsWith(`${destination}/`))) throw new Error('目标路径已有编辑会话，请先保存并关闭该标签页')
  }
  const perform = async (entry: Entry, destination?: string, quiet = false) => {
    if (uploading) throw new Error('附件正在上传，请完成后再操作文件')
    if (destination !== undefined) checkDestination(entry, destination)
    const affected = workspace.lockTree(entry.path, destination)
    let mutationStarted = false
    let mutationConfirmed = false
    let notice = ''
    try {
      const revision = await prepare(entry, affected)
      mutationStarted = true
      if (destination) {
        await api.move(entry.path, destination, revision.revision)
        mutationConfirmed = true
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
        notice = typeRefreshFailed ? '路径已更新，但文件类型刷新失败。当前草稿仍保留，请关闭并重新打开文件；相关 Markdown 链接需手动检查。' : '文件路径已更新。Markdown 链接不会自动改写，请检查相关引用。'
      } else {
        await api.trash(entry.path, revision.revision)
        mutationConfirmed = true
        for (const session of affected) workspace.remove(session.path, true)
        onDelete(entry.path); notice = '已移到回收站，可从回收站恢复。'
      }
      try { await refresh() } catch { notice += ' 列表刷新失败，请刷新确认；不要重复操作已完成项。' }
      if (!quiet) onNotice(notice)
      return notice
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : '文件操作失败，请保留草稿并刷新列表确认'
      if ((problem instanceof ApiError && [404, 412].includes(problem.status)) || problem instanceof EntryTypeChangedError) workspace.operationFailed(affected, message, true)
      const uncertain = mutationStarted && (mutationConfirmed || !(problem instanceof ApiError) || problem.status >= 500 || problem.code === 'durability_uncertain')
      if (uncertain) workspace.operationFailed(affected, message, false)
      if (!quiet) onNotice(message)
      void refresh().catch(() => {})
      if (uncertain) throw new UncertainOperationError(message)
      throw problem
    } finally { workspace.unlock(affected, [entry.path, ...(destination ? [destination] : [])]) }
  }
  const show = (type: Operation['type'], selection: Entry | Entry[]) => {
    if (running.current) return
    const selected = Array.isArray(selection) ? selection : [selection]
    const entries = selected.filter((entry, index) => selected.findIndex((candidate) => candidate.path === entry.path) === index && !selected.some((ancestor) => ancestor.kind === 'directory' && entry.path.startsWith(`${ancestor.path}/`))).map((entry) => ({ ...entry }))
    if (!entries.length) return
    setError(''); setTargetReady(false); setTarget(entries.length === 1 ? entries[0].path.split('/').slice(0, -1).join('/') : '')
    setOperation({ type, entries, total: entries.length, completed: 0, batch: entries.length > 1, blocked: false })
  }
  const destinations = operation?.type === 'move' ? operation.entries.map(entry => target ? `${target}/${entry.name}` : entry.name) : []
  const invalidTarget = destinations.some((path, index) => path === operation?.entries[index].path) ? '已在此文件夹' : destinations.some((path, index) => destinations.indexOf(path) !== index) ? '存在同名目标，请分别移动' : ''
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
    showMove: (entry: Entry | Entry[]) => show('move', entry),
    showDelete: (entry: Entry | Entry[]) => show('delete', entry),
    dialogs: <Dialog.Root open={!!operation} onOpenChange={(value) => { if (!value && !running.current) setOperation(undefined) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className={`dialog-content ${operation?.type === 'move' ? 'entry-move-dialog' : ''}`}><Dialog.Title>{operation?.type === 'delete' ? '移到回收站？' : '移动到'}</Dialog.Title><Dialog.Description className={operation?.type === 'move' ? 'visually-hidden' : undefined}>{operation?.type === 'move' ? '选择目标文件夹，保留原名称，不覆盖已有项目。' : operation?.batch ? `共 ${operation.total} 项，已完成 ${operation.completed} 项，剩余 ${operation.entries.length} 项。以下项目将移到回收站，保留可恢复副本。逐项执行，失败立即停止，已完成项不会回滚。` : `「${operation?.entries[0]?.path ?? ''}」将移到回收站，保留可恢复副本。`}</Dialog.Description>
      {operation?.type === 'move' && <p className="operation-selection" title={operation.entries.map(entry => entry.path).join('\n')}>{operation.completed ? `剩余 ${operation.entries.length} 项` : operation.entries.length === 1 ? operation.entries[0].name : `已选择 ${operation.entries.length} 项`}</p>}
      {operation?.batch && (operation.type === 'delete' || !!error) && <ul className="operation-targets" tabIndex={0} aria-label="剩余操作目标">{operation.entries.map((entry) => <li key={entry.path}>{entry.path}</li>)}</ul>}
      <form onSubmit={async (event) => {
        event.preventDefault(); if (!operation || operation.blocked || running.current) return
        if (operation.type === 'move' && !targetReady) { setError('目标目录尚未读取成功，请重试或选择其他目录。'); return }
        running.current = true; setBusy(true); setError('')
        let remaining = operation.entries
        let completed = operation.completed
        const notices = new Set<string>()
        try {
          for (const [index, destination] of destinations.entries()) {
            checkDestination(remaining[index], destination)
            if (destinations.indexOf(destination) !== index) throw new Error('选中项目存在同名目标，请分别移动')
            if (remaining.some((entry) => destination === entry.path || (entry.kind === 'directory' && destination.startsWith(`${entry.path}/`)))) throw new Error('目标与选中项目冲突，不能移入选中目录或覆盖选中项目')
          }
          for (const [index, entry] of operation.entries.entries()) {
            notices.add(await perform(entry, destinations[index], true))
            completed++; remaining = remaining.slice(1)
            setOperation({ ...operation, entries: remaining, completed })
          }
          onNotice(operation.batch ? `已完成 ${completed} 项。${[...notices].join(' ')}` : [...notices].join(' '))
          setOperation(undefined)
        } catch (problem) {
          const uncertain = problem instanceof UncertainOperationError
          const blocked = uncertain || problem instanceof EntryTypeChangedError
          const message = `${problem instanceof Error ? problem.message : '操作失败，草稿与恢复记录已保留'}${uncertain ? ' 本次操作结果未知，禁止直接重试。请关闭此窗口，刷新并核对源路径、目标路径或回收站后，再重新选择尚未完成的项目。' : ''}`
          const summary = operation.batch ? `已完成 ${completed}/${operation.total} 项，剩余 ${remaining.length} 项；已完成项不会回滚或再次执行。${[...notices].join(' ')} ${message}` : message
          setOperation({ ...operation, entries: remaining, completed, blocked }); setError(summary); onNotice(summary)
        } finally { running.current = false; setBusy(false) }
      }}>{operation?.type === 'move' && <DirectoryPicker directory={target} entries={operation.entries} disabled={busy || operation.blocked} onReadyChange={setTargetReady} onChange={path => { if (!running.current && !operation.blocked && path !== target) { setTargetReady(false); setTarget(path) } }} />}
      {error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions">{operation?.type === 'move' && invalidTarget && <span className="move-location-hint">{invalidTarget}</span>}<Button type="button" onClick={() => { if (!running.current) setOperation(undefined) }} disabled={busy}>{operation?.blocked ? '关闭' : '取消'}</Button><Button type="submit" variant="outline" disabled={busy || operation?.blocked || (operation?.type === 'move' && (!targetReady || !!invalidTarget))}>{busy ? '正在处理…' : operation?.type === 'delete' ? '移到回收站' : '移动到此'}</Button></div></form>
    </DialogContent></Dialog.Portal></Dialog.Root>,
  }
}
