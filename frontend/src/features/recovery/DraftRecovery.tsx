import { DialogContent } from '../../components/ui/dialog-content'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '../../components/ui/button'
import { api, downloadDraft } from '../../services/api'
import type { FileContent } from '../../services/api'
import { workspace } from '../../sessions/current'
import { validDraft } from '../../sessions/drafts'
import type { DraftManager } from '../../sessions/drafts'

export function DraftRecovery({ manager, open, onOpenChange, onOpen, onNotice }: { manager: DraftManager; open: boolean; onOpenChange: (value: boolean) => void; onOpen: (path: string) => void; onNotice: (message: string) => void }) {
  const state = useSyncExternalStore(manager.subscribe, manager.snapshot)
  const [raw, setRaw] = useState<unknown>()
  const [remote, setRemote] = useState<FileContent>()
  const [diskMessage, setDiskMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [copyPath, setCopyPath] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const sequence = useRef(0)
  const dump = useMemo(() => { try { return { text: JSON.stringify(raw, null, 2) ?? '', exportable: true } } catch { return { text: '这条记录包含无法导出的数据结构，请保留浏览器数据并联系维护者。', exportable: false } } }, [raw])
  const cancelRequests = useCallback(() => { sequence.current++ }, [])
  const draft = validDraft(raw, manager.scope) ? raw : undefined
  useEffect(() => {
    if (open) void manager.refresh().catch((error) => setError(error instanceof Error ? error.message : '恢复记录读取失败'))
    return cancelRequests
  }, [open, manager, cancelRequests])
  const close = (value: boolean) => { if (busy) return; if (!value) { sequence.current++; setRaw(undefined); setError(''); setConfirmDelete(false) }; onOpenChange(value) }
  const select = async (id: string) => {
    const request = ++sequence.current
    setReading(true); setError(''); setRaw(undefined); setRemote(undefined); setDiskMessage(''); setConfirmDelete(false)
    try {
      const value = await manager.load(id)
      if (request !== sequence.current) return
      setRaw(value)
      if (validDraft(value, manager.scope)) {
        setCopyPath(value.path.replace(/(\.[^/.]+)?$/, `.恢复-${crypto.randomUUID().slice(0, 12)}$1`))
        try {
          const file = await api.read(value.path, AbortSignal.timeout(10_000))
          if (request !== sequence.current) return
          setRemote(file); setDiskMessage(file.content === value.source ? '磁盘已包含相同正文。可核对后删除这条浏览器记录。' : file.revision === value.revision ? '磁盘仍是草稿的基准版本。打开后请核对，再手动保存。' : '磁盘版本已变化。打开后进入冲突状态，可保留独立副本。')
        } catch (error) { if (request === sequence.current) setDiskMessage(`磁盘版本尚未核对：${error instanceof Error ? error.message : '读取失败'}。可以下载或另存副本。`) }
      }
    } catch (error) { if (request === sequence.current) setError(error instanceof Error ? error.message : '恢复记录读取失败') }
    finally { if (request === sequence.current) setReading(false) }
  }
  const removeAfterPreserved = async () => {
    try { await manager.flush(); await manager.remove(raw) }
    catch (error) { onNotice(`草稿已保留，但旧恢复记录未能移除：${error instanceof Error ? error.message : '存储失败'}。可稍后在恢复窗口检查。`) }
  }
  const apply = async () => {
    if (!draft) return
    setBusy(true); setError('')
    try {
      workspace.restoreDraft({ path: draft.path, source: draft.source, original: draft.original, revision: draft.revision, viewer: draft.viewer, mode: 'source' }, !remote || remote.revision !== draft.revision)
      await removeAfterPreserved()
      onOpen(draft.path); onOpenChange(false); setRaw(undefined)
    } catch (error) { setError(error instanceof Error ? error.message : '恢复失败，浏览器记录仍保留') }
    finally { setBusy(false) }
  }
  const saveCopy = async () => {
    if (!draft) return
    if (!copyPath.trim() || copyPath === draft.path || workspace.has(copyPath) || workspace.isLocked(copyPath)) { setError('请选择不同于原路径且未打开的新副本路径'); return }
    setBusy(true); setError('')
    try {
      const file = await api.create(copyPath, draft.source)
      if (workspace.has(file.path) || workspace.isLocked(file.path)) throw new Error('副本已写入，但该路径的会话发生变化；恢复记录仍保留，请刷新目录确认')
      workspace.add({ path: file.path, source: draft.source, revision: file.revision, mode: 'source' })
      await removeAfterPreserved(); onOpen(file.path); onOpenChange(false); setRaw(undefined)
    } catch (error) { setError(error instanceof Error ? error.message : '副本保存失败，恢复记录仍保留') }
    finally { setBusy(false) }
  }
  return <Dialog.Root open={open} onOpenChange={close}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content recovery-dialog"><Dialog.Title>浏览器恢复稿</Dialog.Title><Dialog.Description>仅保存在本机浏览器，不是磁盘文件或备份。可能来自另一个仍打开的页面；这里不会自动覆盖任何文件。</Dialog.Description>
    {state.warning && <p className="form-error" role="alert">{state.warning}</p>}{error && <p className="form-error" role="alert">{error}</p>}
    <div className="recovery-layout"><div className="recovery-list" aria-label="可恢复的草稿">{state.entries.map((entry) => <button key={entry.id} disabled={busy} aria-pressed={!!raw && (raw as { id?: string }).id === entry.id} onClick={() => void select(entry.id)}><strong>{entry.path}</strong><span>{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString('zh-CN') : '时间未知'}{entry.invalid ? ' · 仅可导出原始记录' : ''}</span></button>)}{!state.entries.length && <p>{state.phase === 'opening' ? '正在读取本机恢复记录…' : '没有待处理恢复稿。当前页面中的草稿仍由各自标签页管理。'}</p>}</div>
      <div className="recovery-preview">{raw ? <>
        <div className="compare-columns"><div><label htmlFor="recovery-source">浏览器草稿正文</label><textarea id="recovery-source" readOnly value={draft ? draft.source : dump.text} /></div>{draft && <div><label htmlFor="recovery-remote">当前磁盘正文</label><textarea id="recovery-remote" readOnly value={remote?.content ?? (reading ? '正在读取磁盘版本…' : '当前磁盘正文不可读')} /></div>}</div>
        {diskMessage && <p role="status">{diskMessage}</p>}
        <div className="recovery-actions"><Button disabled={!draft && !dump.exportable} onClick={() => downloadDraft(draft?.path ?? '浏览器恢复记录.json', draft?.source ?? dump.text)}>下载恢复稿</Button>{draft && <Button variant="outline" disabled={busy || reading} onClick={() => void apply()}>打开为待确认草稿</Button>}<Button disabled={busy || reading} onClick={() => setConfirmDelete(!confirmDelete)}>删除这条浏览器记录…</Button></div>
        {draft && <><label htmlFor="recovery-copy">恢复副本路径</label><input id="recovery-copy" value={copyPath} onChange={(event) => setCopyPath(event.target.value)} disabled={busy} /><p>原文件缺失、发生冲突或标签页已打开时，可另存到存在的目录；同名文件不会覆盖。</p><Button variant="outline" disabled={busy || reading || !copyPath.trim()} onClick={() => void saveCopy()}>另存恢复副本</Button></>}
        {confirmDelete && <div className="recovery-delete" role="alert"><p>删除后将无法从这条浏览器记录恢复。磁盘文件与其他页面的草稿不会删除。</p><Button disabled={busy} onClick={() => setConfirmDelete(false)}>取消删除</Button><Button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await manager.remove(raw); setRaw(undefined); setConfirmDelete(false) } catch (error) { setError(error instanceof Error ? error.message : '删除失败，记录仍保留') } finally { setBusy(false) } }}>确认删除浏览器记录</Button></div>}
      </> : <p>{reading ? '正在读取恢复稿…' : '选择一条记录核对正文，然后下载、打开或另存。未知格式不会自动丢弃。'}</p>}</div></div>
    <div className="dialog-actions"><Button disabled={busy} onClick={() => void manager.refresh().catch((error) => setError(error instanceof Error ? error.message : '刷新失败'))}>刷新记录</Button><Button variant="outline" disabled={busy} onClick={() => close(false)}>关闭</Button></div>
  </DialogContent></Dialog.Portal></Dialog.Root>
}
