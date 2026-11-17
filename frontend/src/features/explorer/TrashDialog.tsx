import { DialogContent } from '../../components/ui/dialog-content'
import { useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { RefreshCw, Search, Trash2, Undo2, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { api, type TrashRecord } from '../../services/api'
import { FileIcon, FolderIcon } from './FileIcon'
import { notify } from '../../stores/notifications'

export function TrashDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
  const client = useQueryClient()
  const [purgeRecords, setPurgeRecords] = useState<TrashRecord[]>([])
  const [working, setWorking] = useState('')
  const [message, setMessage] = useState('')
  const [needsReview, setNeedsReview] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('newest')
  const query = useInfiniteQuery({ queryKey: ['trash'], queryFn: ({ pageParam }) => api.trashList(pageParam), initialPageParam: 0, getNextPageParam: (last) => last.offset + last.entries.length < last.total ? last.offset + last.entries.length : undefined, enabled: open, retry: false })
  const records = query.data?.pages.flatMap((page) => page.entries) ?? []
  const visible = records.filter((record) => record.path.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a, b) =>
    sort === 'name' ? a.path.localeCompare(b.path, 'zh-CN', { numeric: true }) : sort === 'oldest' ? a.deletedAt.localeCompare(b.deletedAt) : b.deletedAt.localeCompare(a.deletedAt))
  const chosen = visible.filter((record) => selected.has(record.id))
  const disabled = !!working || query.isFetching || !!query.error || needsReview
  const allSelected = visible.length > 0 && chosen.length === visible.length

  async function refresh() {
    setSelected(new Set())
    const result = await query.refetch()
    if (!result.isError) setNeedsReview(false)
  }

  async function run(action: 'restore' | 'purge', targets: TrashRecord[]) {
    if (!targets.length || disabled) return
    setWorking('准备处理…'); setMessage(''); setSelected(new Set()); setPurgeRecords([])
    let completed = 0
    const notification = notify.loading(action === 'restore' ? '正在恢复文件' : '正在永久删除', { progress: 0 })
    try {
      for (const record of targets) {
        setWorking(`${action === 'restore' ? '正在恢复' : '正在删除'} ${completed + 1} / ${targets.length}`)
        if (action === 'restore') await api.restore(record.id)
        else await api.purge(record.id)
        completed++
        notify.update(notification, { progress: completed / targets.length * 100 })
      }
      notify.success(action === 'restore' && targets.length === 1 ? `已恢复 ${targets[0].path}` : `已${action === 'restore' ? '恢复' : '永久删除'} ${completed} 项。`, { id: notification })
    } catch (error) {
      notify.dismiss(notification)
      setMessage(`${completed ? `已完成 ${completed} 项，其余操作已停止。` : ''}${error instanceof Error ? error.message : '操作失败，记录仍保留'}`)
      setNeedsReview(true)
    } finally {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['trash'] }),
        client.invalidateQueries({ queryKey: ['tree'] }),
        client.invalidateQueries({ queryKey: ['usage'] }),
      ])
      setWorking('')
    }
  }

  return <Dialog.Root open={open} onOpenChange={(value) => {
    if (working) return
    setSelected(new Set()); setSearch(''); if (!needsReview) setMessage(''); onOpenChange(value)
  }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content trash-dialog" aria-describedby={undefined}>
    <header className="trash-heading">
      <Dialog.Title><Trash2 size={20} aria-hidden="true" />回收站</Dialog.Title>
    </header>
    <div className="trash-toolbar">
      <label className="trash-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索已加载的回收记录" placeholder="搜索名称或原路径" value={search} disabled={!!working} onChange={(event) => { setSearch(event.target.value); setSelected(new Set()) }} /></label>
      <select aria-label="回收记录排序" value={sort} disabled={!!working} onChange={(event) => setSort(event.target.value)}><option value="newest">最近删除优先</option><option value="oldest">最早删除优先</option><option value="name">名称排序</option></select>
      <Button size="icon" aria-label="刷新回收站" title="刷新回收站" disabled={!!working || query.isFetching} onClick={() => void refresh()}><RefreshCw size={16} /></Button>
    </div>
    <div className="trash-selection">
      <span>{chosen.length ? `已选择 ${chosen.length} 项` : '选择文件以批量管理'}</span>
      <Button disabled={disabled || !chosen.length || chosen.some((record) => record.state === 'damaged')} onClick={() => void run('restore', chosen)}><Undo2 size={15} />恢复所选</Button>
      <Button className="trash-danger" disabled={disabled || !chosen.length || chosen.some((record) => record.state !== 'ready')} onClick={() => setPurgeRecords(chosen)}><Trash2 size={15} />删除所选</Button>
    </div>
    {query.error && <div className="trash-notice" role="alert">{query.error.message}<Button disabled={query.isFetching} onClick={() => void refresh()}>重试</Button></div>}
    {message && <div className="trash-notice" role={needsReview ? 'alert' : 'status'}><span>{message}</span>{needsReview && <small>请刷新核对文件与回收记录，再重新选择；已成功的操作不会回滚。</small>}</div>}
    <div className="trash-list" aria-busy={query.isFetching || !!working}>
      <table className="trash-table">
        <thead><tr>
          <th className="trash-check"><label><input type="checkbox" aria-label="全选当前列表" checked={allSelected} ref={(input) => { if (input) input.indeterminate = chosen.length > 0 && !allSelected }} disabled={disabled || !visible.length} onChange={() => setSelected(allSelected ? new Set() : new Set(visible.map((record) => record.id)))} /></label></th>
          <th scope="col">名称</th><th scope="col" className="trash-location">原位置</th><th scope="col" className="trash-date">删除时间</th><th scope="col" className="trash-state">状态</th><th scope="col" className="trash-actions">操作</th>
        </tr></thead>
        <tbody>{visible.map((record) => {
          const name = record.path.split('/').at(-1) ?? record.path
          const parent = record.path.includes('/') ? record.path.slice(0, record.path.lastIndexOf('/')) : '根目录'
          const state = record.state === 'ready' ? '可恢复' : record.state === 'damaged' ? '记录损坏' : '操作未完成'
          return <tr key={record.id} data-selected={selected.has(record.id)}>
            <td className="trash-check"><label><input type="checkbox" aria-label={`选择 ${record.path}`} checked={selected.has(record.id)} disabled={disabled} onChange={() => setSelected((previous) => { const next = new Set(previous); if (next.has(record.id)) next.delete(record.id); else next.add(record.id); return next })} /></label></td>
            <td><div className="trash-filename">{record.kind === 'directory' ? <FolderIcon path={record.path} /> : <FileIcon path={record.path} />}<div><span title={record.path}>{name}</span><small className="trash-mobile-detail" title={record.path}>{parent} · {state}</small></div></div></td>
            <td className="trash-location"><span title={parent}>{parent}</span></td>
            <td className="trash-date">{record.deletedAt ? new Date(record.deletedAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间未知'}</td>
            <td className="trash-state"><span className={record.state === 'ready' ? '' : 'trash-warning'} title={record.state === 'damaged' ? '记录损坏，需检查应用数据目录' : record.state === 'ready' ? '可恢复到原位置' : '操作未完成，原件或副本已保留'}>{state}</span></td>
            <td className="trash-actions"><Button size="icon" aria-label={record.state === 'ready' ? '恢复' : '尝试恢复'} title={`恢复 ${record.path}`} disabled={disabled || record.state === 'damaged'} onClick={() => void run('restore', [record])}><Undo2 size={16} /></Button><Button size="icon" className="trash-danger" aria-label="永久删除" title={`永久删除 ${record.path}`} disabled={disabled || record.state !== 'ready'} onClick={() => setPurgeRecords([record])}><Trash2 size={16} /></Button></td>
          </tr>
        })}</tbody>
      </table>
      {query.isPending && <p className="trash-empty" role="status">正在读取恢复记录…</p>}
      {!query.isPending && !query.error && !visible.length && <div className="trash-empty"><Trash2 size={28} aria-hidden="true" /><p>{records.length || search ? '已加载记录中没有匹配项' : '回收站为空'}</p><small>{records.length || search ? '试试其他名称或路径，或继续加载更多记录。' : '删除的文件与文件夹会显示在这里。'}</small></div>}
    </div>
    <footer className="trash-footer"><span>{working || `共 ${query.data?.pages[0]?.total ?? 0} 项 · 已加载 ${records.length} 项${search ? ` · 匹配 ${visible.length} 项` : ''}`}</span>{query.hasNextPage && <Button variant="outline" disabled={!!working || query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '正在加载…' : '加载更多'}</Button>}</footer>
    <Dialog.Root open={purgeRecords.length > 0} onOpenChange={(value) => { if (!value && !working) setPurgeRecords([]) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content">
      <Dialog.Title>永久删除</Dialog.Title><Dialog.Description>将永久删除以下 {purgeRecords.length} 项并释放配额，此操作无法撤销。文件夹包含的全部内容也会删除。</Dialog.Description>
      <ul className="trash-confirm-list">{purgeRecords.map((record) => <li key={record.id}>{record.path}</li>)}</ul>
      <div className="user-form-actions"><Button autoFocus onClick={() => setPurgeRecords([])}>取消</Button><Button variant="outline" className="trash-danger" disabled={disabled} onClick={() => void run('purge', purgeRecords)}>确认永久删除</Button></div>
    </DialogContent></Dialog.Portal></Dialog.Root>
    <Dialog.Close asChild><Button size="icon" className="dialog-close" aria-label="关闭回收站" disabled={!!working}><X size={17} /></Button></Dialog.Close>
  </DialogContent></Dialog.Portal></Dialog.Root>
}
