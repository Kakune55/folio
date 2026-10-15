import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight, FileText, Folder, FolderOpen, MoreHorizontal, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { api } from '../../services/api'
import type { Entry } from '../../services/api'

type ExplorerProps = { active: string; directory: string; setDirectory: (path: string) => void; onOpen: (path: string) => void; onRename: (entry: Entry, name: string) => Promise<void>; onMove: (entry: Entry) => void; onDelete: (entry: Entry) => void }
export function Explorer(props: ExplorerProps) { return <nav aria-label="工作区文件"><FolderContents {...props} path="" depth={0} /></nav> }
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
  const startRename = () => { setName(entry.name); setError(''); setRenaming(true) }
  return <div>
    <div className={`tree-entry ${props.active === entry.path ? 'selected' : ''}`} onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true) }}>
      {renaming ? <form className="inline-rename" onSubmit={async (event) => {
        event.preventDefault(); setError('')
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) { setError('请输入不含路径分隔符的文件名'); return }
        if (name === entry.name) { setRenaming(false); return }
        setBusy(true)
        try { await props.onRename(entry, name); setRenaming(false) } catch (problem) { setError(problem instanceof Error ? problem.message : '重命名失败') } finally { setBusy(false) }
      }}><input aria-label={`重命名 ${entry.name}`} value={name} disabled={busy} maxLength={255} autoFocus onFocus={(event) => { const dot = !directory ? name.lastIndexOf('.') : -1; event.target.setSelectionRange(0, dot > 0 ? dot : name.length) }} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); setRenaming(false) } }} /><Button size="icon" type="submit" aria-label="确认重命名" disabled={busy}><Check size={13} /></Button><Button size="icon" type="button" aria-label="取消重命名" disabled={busy} onClick={() => setRenaming(false)}><X size={13} /></Button></form> : <>
        <button className={`file-row ${directory ? 'folder-row' : ''} ${props.active === entry.path ? 'selected' : ''} ${directory && props.directory === entry.path ? 'directory-selected' : ''}`} style={{ paddingLeft: (directory ? 4 : 16) + props.depth * 14 }} aria-current={props.active === entry.path ? 'page' : undefined} aria-expanded={directory ? expanded : undefined} onClick={() => { if (directory) { setExpanded(!expanded); props.setDirectory(entry.path) } else props.onOpen(entry.path) }} title={entry.path}>{directory && <ChevronRight size={13} className={expanded ? 'expanded' : ''} />}{directory ? expanded ? <FolderOpen size={16} /> : <Folder size={16} /> : <FileText size={16} />}<span>{entry.name}</span></button>
        <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}><Menu.Trigger asChild><Button className="entry-menu-trigger" size="icon" aria-label={`文件操作 ${entry.name}`} title="文件操作"><MoreHorizontal size={15} /></Button></Menu.Trigger><Menu.Portal><Menu.Content className="context-menu" align="end" sideOffset={4}>
          <Menu.Item onSelect={startRename}>重命名</Menu.Item><Menu.Item onSelect={() => props.onMove(entry)}>移动到…</Menu.Item><Menu.Separator /><Menu.Item className="destructive" onSelect={() => props.onDelete(entry)}>移到回收站</Menu.Item>
        </Menu.Content></Menu.Portal></Menu.Root>
      </>}
    </div>
    {error && renaming && <p className="tree-message form-error" role="alert">{error}</p>}
    {directory && expanded && <FolderContents {...props} path={entry.path} depth={props.depth + 1} />}
  </div>
}
