import { FileIcon } from '../explorer/FileIcon'
import { DialogContent } from '../../components/ui/dialog-content'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { Search, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { literalRange } from './location'
import { api } from '../../services/api'

export function SearchDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (path: string, query: string, contentMatch: boolean) => void }) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [message, setMessage] = useState('')
  const [rebuilding, setRebuilding] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ path: string; query: string; offset: number; scroll: number } | null>(null)
  const client = useQueryClient()
  useEffect(() => { const timer = setTimeout(() => setQuery(input), 180); return () => clearTimeout(timer) }, [input])
  const status = useQuery({ queryKey: ['search-status'], queryFn: api.searchStatus, refetchInterval: 1500, retry: false })
  const names = useQuery({ queryKey: ['search', 'names', query], queryFn: ({ signal }) => api.search(query, 'names', signal), retry: false, refetchInterval: 2000 })
  const full = useQuery({ queryKey: ['search', 'full', query], queryFn: ({ signal }) => api.search(query, 'full', signal), enabled: !!query.trim(), retry: false, refetchInterval: 2000 })
  const changing = input !== query
  const files = changing ? [] : names.data?.entries ?? []
  const content = changing ? [] : full.data?.entries ?? []
  const filePaths = new Set(files.map((entry) => entry.path))
  const excerpts = new Map(content.map((entry) => [entry.path, entry.excerpt]))
  const bodyEntries = content.filter((entry) => !filePaths.has(entry.path))
  const entries = [...files.map((entry) => ({ ...entry, excerpt: excerpts.get(entry.path) ?? '' })), ...bodyEntries]
  const active = Math.max(0, entries.findIndex((entry) => entry.path === selected))
  const namesWaiting = changing || names.isPending
  const fullWaiting = !!input.trim() && (changing || full.isPending)
  const waiting = namesWaiting || fullWaiting
  const index = status.data ?? names.data?.status ?? full.data?.status
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  useLayoutEffect(() => {
    const container = list.current
    const item = container?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!container || !item) { anchor.current = null; return }
    const path = entries[active].path
    const previous = anchor.current
    if (previous?.query !== query) container.style.paddingBottom = ''
    const offset = item.getBoundingClientRect().top - container.getBoundingClientRect().top
    // 异步补充摘要或文件分组时，保持当前结果在视口中的位置；用户滚动优先。
    if (previous?.path === path && previous.query === query && previous.scroll === container.scrollTop) {
      const target = container.scrollTop + offset - previous.offset
      const maximum = container.scrollHeight - container.clientHeight
      // 列表尾部需要保留滚动余量，否则浏览器会截断补偿并把选中项推到底部。
      if (target > maximum) {
        const padding = parseFloat(getComputedStyle(container).paddingBottom) || 0
        container.style.paddingBottom = `${padding + target - maximum}px`
      }
      container.scrollTop = target
    }
    anchor.current = { path, query, offset: item.getBoundingClientRect().top - container.getBoundingClientRect().top, scroll: container.scrollTop }
  })
  const choose = (path: string) => { if (!changing) { const excerpt = excerpts.get(path) ?? ''; onClose(); onOpen(path, query, !!query.trim() && (!literalRange(path, query) || !!literalRange(excerpt, query))) } }
  return <Dialog.Root open onOpenChange={(value) => { if (!value) onClose() }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content search-dialog">
    <div className="search-heading"><Dialog.Title>搜索</Dialog.Title><Dialog.Close asChild><Button size="icon" aria-label="关闭搜索"><X size={17} /></Button></Dialog.Close></div>
    <Dialog.Description className="visually-hidden">搜索文件名、路径和已保存的文本，使用上下方向键选择，回车打开。</Dialog.Description>
    <div className="search-input"><Search size={17} /><input role="combobox" aria-label="搜索文件与内容" aria-expanded="true" aria-controls="search-results" aria-autocomplete="list" aria-activedescendant={!changing && entries.length ? `search-result-${active}` : undefined} placeholder="搜索文件与内容…" autoFocus maxLength={200} value={input} onChange={(event) => { setInput(event.target.value); setSelected('') }} onKeyDown={(event) => {
      if (changing || !entries.length) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = (active + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length; setSelected(entries[next].path) }
      if (event.key === 'Enter') { event.preventDefault(); choose(entries[active].path) }
    }} /></div>
    {(index?.warning || status.error || message) && <p className="search-notice" role="status">{message || status.error?.message || index?.warning}</p>}
    <div id="search-results" className="search-results" role="listbox" aria-label="搜索结果" ref={list} aria-busy={waiting}>
      {entries.map((entry, position) => <div role="presentation" key={entry.path}>
        {(position === 0 || position === files.length) && <div className="search-group" role="presentation">{position < files.length ? '文件' : '内容'}</div>}
        <button role="option" tabIndex={-1} id={`search-result-${position}`} aria-selected={position === active} className="search-result" onMouseMove={() => { if (selected !== entry.path) setSelected(entry.path) }} onClick={() => choose(entry.path)}><FileIcon path={entry.path} /><div><strong>{entry.name}</strong><span>{entry.path}</span>{entry.excerpt && <p>{entry.excerpt}</p>}</div></button>
      </div>)}
      {namesWaiting && <p className="search-progress" role="status">正在查找文件…</p>}
      {fullWaiting && <p className="search-progress" role="status">正在查找内容…</p>}
      {names.error && <p className="search-notice" role="status">文件搜索失败：{names.error.message}</p>}
      {query.trim() && full.error && <p className="search-notice" role="status">内容搜索失败：{full.error.message}</p>}
      {!waiting && !entries.length && !names.error && !(query.trim() && full.error) && <p className="search-empty">{index?.indexing ? '正在更新索引，请稍候…' : '没有匹配的文件。'}</p>}
    </div>
    <div className="search-footer"><span>{index?.indexing ? '正在更新索引…' : `${index?.files ?? 0} 个已索引文件`}{(names.data?.truncated || (!!query.trim() && full.data?.truncated)) ? ' · 结果较多，请缩小查询' : ''}</span><div><Button disabled={rebuilding || index?.indexing} onClick={async () => {
      setRebuilding(true); setMessage('')
      try { await api.rebuildIndex(); await client.invalidateQueries({ queryKey: ['file-index'] }); setMessage('已请求重建索引，文件编辑不受影响。'); await client.invalidateQueries({ queryKey: ['search-status'] }); await client.invalidateQueries({ queryKey: ['search'] }) }
      catch (error) { setMessage(error instanceof Error ? error.message : '重建索引请求失败') }
      finally { setRebuilding(false) }
    }}>{rebuilding ? '正在请求…' : '重建索引'}</Button></div></div>
  </DialogContent></Dialog.Portal></Dialog.Root>
}
