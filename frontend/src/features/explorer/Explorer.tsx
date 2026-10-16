import { useEffect, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight, Folder, FolderOpen, MoreHorizontal, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { api } from '../../services/api'
import type { Entry } from '../../services/api'
import { EntryDragProvider, useEntryDrag } from './EntryDrag'
import { FileIcon } from './FileIcon'

function focusEntry(nav: Element | null, path: string) {
  requestAnimationFrame(() => [...(nav?.querySelectorAll<HTMLButtonElement>('[data-entry-path]') ?? [])].find((row) => row.dataset.entryPath === path)?.focus())
}

type ExplorerProps = { active: string; directory: string; setDirectory: (path: string) => void; onOpen: (path: string) => void; onRename: (entry: Entry, name: string) => Promise<void>; onMove: (entry: Entry) => void; onDelete: (entry: Entry) => void; onDropMove: (entry: Entry, directory: string) => Promise<void>; onNotice: (message: string) => void; disabled: boolean }
export function Explorer(props: ExplorerProps) {
  return <EntryDragProvider disabled={props.disabled} onMove={props.onDropMove} onNotice={props.onNotice} onDirectory={props.setDirectory}><nav aria-label="工作区文件" onKeyDown={(event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-entry-path]') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-entry-path]')]
    const current = rows.indexOf(event.target as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
    rows[next]?.focus()
  }}><RootFolder {...props} /><FolderContents {...props} path="" depth={0} /></nav></EntryDragProvider>
}
function RootFolder(props: ExplorerProps) {
  const drag = useEntryDrag()
  return <button data-entry-path="" className={`folder-label root-folder ${props.directory === '' ? 'directory-selected' : ''} ${drag.target === '' ? 'drop-target' : ''}`} onClick={() => props.setDirectory('')} onDragOver={(event) => drag.over(event, '')} onDragLeave={drag.leave} onDrop={(event) => drag.drop(event, '')}><FolderOpen size={16} />工作区</button>
}
function FolderContents(props: ExplorerProps & { path: string; depth: number }) {
  const query = useInfiniteQuery({ queryKey: ['tree', props.path], queryFn: ({ pageParam }) => api.tree(props.path, pageParam), initialPageParam: 0, getNextPageParam: (last) => last.offset + last.entries.length < last.total ? last.offset + last.entries.length : undefined, staleTime: 30_000, retry: false })
  if (query.isPending) return <p className="tree-message" role="status">正在读取…</p>
  if (query.error) return <div className="tree-message" role="alert">{query.error.message}<Button onClick={() => void query.refetch()}>重试</Button></div>
  const entries = query.data.pages.flatMap((page) => page.entries)
  return <>{entries.map((entry) => <EntryRow {...props} key={entry.path} entry={entry} />)}
    {entries.length === 0 && <p className="tree-message">{props.path ? '此目录还没有文件' : '工作区为空，创建一篇笔记吧。'}</p>}
    {query.hasNextPage && <Button onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? '正在读取…' : '加载更多'}</Button>}
  </>
}
function EntryRow({ entry, ...props }: ExplorerProps & { depth: number; entry: Entry }) {
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(entry.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const directory = entry.kind === 'directory'
  const drag = useEntryDrag()
  useEffect(() => {
    if (!directory || expanded || drag.target !== entry.path) return
    const timer = setTimeout(() => setExpanded(true), 600)
    return () => clearTimeout(timer)
  }, [directory, expanded, drag.target, entry.path])
  const startRename = () => { setName(entry.name); setError(''); setRenaming(true) }
  return <div>
    <div className={`tree-entry ${props.active === entry.path ? 'selected' : ''}`} onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true) }}>
      {renaming ? <form className="inline-rename" onSubmit={async (event) => {
        event.preventDefault(); setError('')
        const nav = event.currentTarget.closest('nav')
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) { setError('请输入不含路径分隔符的文件名'); return }
        if (name === entry.name) { setRenaming(false); focusEntry(nav, entry.path); return }
        setBusy(true)
        try { await props.onRename(entry, name); setRenaming(false); const parent = entry.path.split('/').slice(0, -1).join('/'); const destination = parent ? `${parent}/${name}` : name; focusEntry(nav, destination) } catch (problem) { setError(problem instanceof Error ? problem.message : '重命名失败') } finally { setBusy(false) }
      }}><input aria-label={`重命名 ${entry.name}`} value={name} disabled={busy} maxLength={255} autoFocus onFocus={(event) => { const dot = !directory ? name.lastIndexOf('.') : -1; event.target.setSelectionRange(0, dot > 0 ? dot : name.length) }} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); setRenaming(false); focusEntry(event.currentTarget.closest('nav'), entry.path) } }} /><Button size="icon" type="submit" aria-label="确认重命名" disabled={busy}><Check size={13} /></Button><Button size="icon" type="button" aria-label="取消重命名" disabled={busy} onClick={(event) => { setRenaming(false); focusEntry(event.currentTarget.closest('nav'), entry.path) }}><X size={13} /></Button></form> : <>
        <button data-entry-path={entry.path} draggable={!props.disabled && !drag.busy && !busy} onDragStart={(event) => drag.start(event, entry)} onDragEnd={drag.end} onDragOver={directory ? (event) => drag.over(event, entry.path) : undefined} onDragLeave={directory ? drag.leave : undefined} onDrop={directory ? (event) => { if (drag.drop(event, entry.path)) setExpanded(true) } : undefined} onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return
          if (event.key === 'F2') { event.preventDefault(); startRename() }
          if (event.key === 'Delete') { event.preventDefault(); props.onDelete(entry) }
          if (event.shiftKey && event.key === 'F10') { event.preventDefault(); setMenuOpen(true) }
          if (event.key === 'ArrowRight' && directory) { event.preventDefault(); if (!expanded) setExpanded(true); else [...event.currentTarget.closest('nav')!.querySelectorAll<HTMLButtonElement>('[data-entry-path]')].find((row) => row.dataset.entryPath?.startsWith(`${entry.path}/`))?.focus() }
          else if (event.key === 'ArrowLeft') { event.preventDefault(); if (directory && expanded) setExpanded(false); else { const parent = entry.path.split('/').slice(0, -1).join('/'); [...event.currentTarget.closest('nav')!.querySelectorAll<HTMLButtonElement>('[data-entry-path]')].find((row) => row.dataset.entryPath === parent)?.focus() } }
        }} className={`file-row ${directory ? 'folder-row' : ''} ${drag.target === entry.path ? 'drop-target' : ''} ${drag.entry?.path === entry.path ? 'drag-source' : ''} ${props.active === entry.path ? 'selected' : ''} ${directory && props.directory === entry.path ? 'directory-selected' : ''}`} style={{ paddingLeft: (directory ? 4 : 16) + props.depth * 14 }} aria-current={props.active === entry.path ? 'page' : undefined} aria-expanded={directory ? expanded : undefined} onClick={() => { if (directory) { setExpanded(!expanded); props.setDirectory(entry.path) } else props.onOpen(entry.path) }} title={entry.path}>{directory && <ChevronRight size={13} className={expanded ? 'expanded' : ''} />}{directory ? expanded ? <FolderOpen size={16} /> : <Folder size={16} /> : <FileIcon path={entry.path} />}<span>{entry.name}</span></button>
        <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}><Menu.Trigger asChild><Button className="entry-menu-trigger" size="icon" aria-label={`文件操作 ${entry.name}`} title="文件操作"><MoreHorizontal size={15} /></Button></Menu.Trigger><Menu.Portal><Menu.Content className="context-menu" align="end" sideOffset={4}>
          <Menu.Item onSelect={startRename}>重命名</Menu.Item><Menu.Item onSelect={() => props.onMove(entry)}>移动到…</Menu.Item><Menu.Separator /><Menu.Item className="destructive" onSelect={() => props.onDelete(entry)}>移到回收站</Menu.Item>
        </Menu.Content></Menu.Portal></Menu.Root>
      </>}
    </div>
    {error && renaming && <p className="tree-message form-error" role="alert">{error}</p>}
    {directory && expanded && <FolderContents {...props} path={entry.path} depth={props.depth + 1} />}
  </div>
}
