import { DialogContent } from '../../components/ui/dialog-content'
import { useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { api } from '../../services/api'

export function TrashDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
  const client = useQueryClient()
  const [purgeID, setPurgeID] = useState('')
  const [working, setWorking] = useState('')
  const [message, setMessage] = useState('')
  const query = useInfiniteQuery({ queryKey: ['trash'], queryFn: ({ pageParam }) => api.trashList(pageParam), initialPageParam: 0, getNextPageParam: (last) => last.offset + last.entries.length < last.total ? last.offset + last.entries.length : undefined, enabled: open, retry: false })
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!working) onOpenChange(value) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content trash-dialog"><Dialog.Title>回收站</Dialog.Title><Dialog.Description>恢复到原路径；同名文件已存在时不会覆盖。损坏或未完成的恢复记录会保留供检查。</Dialog.Description>
    {query.isPending && <p role="status">正在读取恢复记录…</p>}{query.error && <p role="alert">{query.error.message}<Button onClick={() => void query.refetch()}>重试</Button></p>}
    {message && <p className="notice" role="status">{message}</p>}
    {query.data?.pages.flatMap((page) => page.entries).map((record) => <div className="trash-row" key={record.id}><div><span title={record.path}>{record.path}</span><small>{record.deletedAt ? new Date(record.deletedAt).toLocaleString('zh-CN') : '时间未知'} · {record.state === 'ready' ? '可恢复' : record.state === 'damaged' ? '记录损坏，需检查应用数据目录' : '操作未完成，原件或副本已保留'}</small></div><Button variant="outline" disabled={!!working || record.state === 'damaged'} onClick={async () => {
      setWorking(record.id); setMessage('')
      try { await api.restore(record.id); setMessage(`已恢复 ${record.path}`); await Promise.all([client.invalidateQueries({ queryKey: ['trash'] }), client.invalidateQueries({ queryKey: ['tree'] })]) }
      catch (error) { setMessage(error instanceof Error ? error.message : '恢复失败，记录仍保留') }
      finally { setWorking('') }
    }}>{working === record.id ? '正在恢复…' : record.state === 'ready' ? '恢复' : '尝试恢复'}</Button><Button disabled={!!working || record.state !== 'ready'} onClick={() => setPurgeID(record.id)}>永久删除</Button></div>)}
    {query.data?.pages[0]?.total === 0 && <p className="trash-empty">回收站为空</p>}
    {query.hasNextPage && <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多</Button>}
    <Dialog.Root open={!!purgeID} onOpenChange={(value) => { if (!value && !working) setPurgeID('') }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content"><Dialog.Title>永久删除</Dialog.Title><Dialog.Description>文件将从回收站永久删除并释放配额，此操作无法撤销。</Dialog.Description><div className="user-form-actions"><Button disabled={!!working} onClick={() => setPurgeID('')}>取消</Button><Button variant="outline" disabled={!!working} onClick={async () => {
      setWorking(purgeID)
      try { await api.purge(purgeID); setPurgeID(''); setMessage('已永久删除。'); await Promise.all([client.invalidateQueries({ queryKey: ['trash'] }), client.invalidateQueries({ queryKey: ['usage'] })]) }
      catch (error) { setMessage(error instanceof Error ? error.message : '永久删除失败，请刷新回收站后重试'); setPurgeID('') }
      finally { setWorking('') }
    }}>确认永久删除</Button></div></DialogContent></Dialog.Portal></Dialog.Root>
    <Dialog.Close asChild><Button size="icon" className="dialog-close" aria-label="关闭回收站" disabled={!!working}><X size={17} /></Button></Dialog.Close>
  </DialogContent></Dialog.Portal></Dialog.Root>
}
