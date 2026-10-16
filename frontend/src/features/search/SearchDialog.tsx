import { FileIcon } from '../explorer/FileIcon'
import { DialogContent } from '../../components/ui/dialog-content'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { Search, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { api } from '../../services/api'

export function SearchDialog({ mode, onClose, onOpen, onMode }: { mode: 'names' | 'full'; onClose: () => void; onOpen: (path: string) => void; onMode: (mode: 'names' | 'full') => void }) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [message, setMessage] = useState('')
  const [rebuilding, setRebuilding] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const client = useQueryClient()
  useEffect(() => { const timer = setTimeout(() => setQuery(input), 180); return () => clearTimeout(timer) }, [input])
  const status = useQuery({ queryKey: ['search-status'], queryFn: api.searchStatus, refetchInterval: 1500, retry: false })
  const results = useQuery({ queryKey: ['search', mode, query], queryFn: ({ signal }) => api.search(query, mode, signal), enabled: mode === 'names' || !!query.trim(), retry: false, refetchInterval: 2000 })
  const entries = results.data?.entries ?? []
  const active = Math.max(0, entries.findIndex((entry) => entry.path === selected))
  const waiting = input !== query || (results.isPending && (mode === 'names' || !!query.trim()))
  const index = status.data ?? results.data?.status
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  const choose = (path: string) => { if (!waiting) { onClose(); onOpen(path) } }
  return <Dialog.Root open onOpenChange={(value) => { if (!value) onClose() }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content search-dialog">
    <div className="search-heading"><Dialog.Title>{mode === 'names' ? '快速打开' : '全文搜索'}</Dialog.Title><Dialog.Close asChild><Button size="icon" aria-label="关闭搜索"><X size={17} /></Button></Dialog.Close></div>
    <Dialog.Description className="visually-hidden">{mode === 'names' ? '按文件名和路径查找，使用上下方向键选择，回车打开。' : '搜索已保存的 Markdown 与符合大小限制的文本内容，方向键选择，回车打开。'}</Dialog.Description>
    <div className="search-input"><Search size={17} /><input role="combobox" aria-label={mode === 'names' ? '查找文件名或路径' : '搜索文件内容'} aria-expanded="true" aria-controls="search-results" aria-autocomplete="list" aria-activedescendant={!waiting && entries.length ? `search-result-${active}` : undefined} placeholder={mode === 'names' ? '输入文件名或路径…' : '输入中文、英文或技术标识符…'} autoFocus maxLength={200} value={input} onChange={(event) => { setInput(event.target.value); setSelected('') }} onKeyDown={(event) => {
      if (waiting || !entries.length) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = (active + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length; setSelected(entries[next].path) }
      if (event.key === 'Enter') { event.preventDefault(); choose(entries[active].path) }
    }} /></div>
    {(index?.warning || status.error || results.error || message) && <p className="search-notice" role="status">{message || results.error?.message || status.error?.message || index?.warning}</p>}
    <div id="search-results" className="search-results" role="listbox" aria-label="搜索结果" ref={list} aria-busy={waiting}>
      {waiting ? <p className="search-empty" role="status">正在查找…</p> : entries.map((entry, position) => <button role="option" tabIndex={-1} id={`search-result-${position}`} aria-selected={position === active} key={entry.path} className="search-result" onMouseMove={() => setSelected(entry.path)} onClick={() => choose(entry.path)}><FileIcon path={entry.path} /><div><strong>{entry.name}</strong><span>{entry.path}</span>{mode === 'full' && entry.excerpt && <p>{entry.excerpt}</p>}</div></button>)}
      {!waiting && !entries.length && !results.error && <p className="search-empty">{mode === 'full' && !query.trim() ? '搜索文件名、路径和已保存的文本。' : index?.indexing ? '正在更新索引，请稍候…' : '没有匹配的文件。'}</p>}
    </div>
    <div className="search-footer"><span>{index?.indexing ? '正在更新索引…' : `${index?.files ?? 0} 个已索引文件`}{results.data?.truncated ? ' · 仅显示前 50 项，请缩小查询' : ''}</span><div><Button onClick={() => onMode(mode === 'names' ? 'full' : 'names')}>{mode === 'names' ? '全文搜索' : '按名称查找'}</Button><Button disabled={rebuilding || index?.indexing} onClick={async () => {
      setRebuilding(true); setMessage('')
      try { await api.rebuildIndex(); setMessage('已请求重建索引，文件编辑不受影响。'); await client.invalidateQueries({ queryKey: ['search-status'] }); await client.invalidateQueries({ queryKey: ['search'] }) }
      catch (error) { setMessage(error instanceof Error ? error.message : '重建索引请求失败') }
      finally { setRebuilding(false) }
    }}>{rebuilding ? '正在请求…' : '重建索引'}</Button></div></div>
  </DialogContent></Dialog.Portal></Dialog.Root>
}
