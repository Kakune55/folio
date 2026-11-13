import { useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactElement } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import * as Menu from '@radix-ui/react-dropdown-menu'
import * as ContextMenu from '@radix-ui/react-context-menu'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, ChevronRight, MoreHorizontal, X } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { DialogContent } from '../../components/ui/dialog-content'
import { api } from '../../services/api'
import type { Entry } from '../../services/api'
import { EntryDragProvider } from './EntryDrag'
import { useEntryDrag } from './drag-context'
import { FileIcon, FolderIcon } from './FileIcon'
import { entryRange, reconcileEntrySelection } from './selection'

function focusEntry(nav: Element | null, path: string) {
  requestAnimationFrame(() => [...(nav?.querySelectorAll<HTMLButtonElement>('[data-entry-path]') ?? [])].find((row) => row.dataset.entryPath === path)?.focus())
}

type ExplorerProps = { active: string; directory: string; setDirectory: (path: string) => void; onOpen: (path: string) => void; onCreate: (kind: 'file' | 'directory', directory: string) => void; onRename: (entry: Entry, name: string) => Promise<void>; onMove: (entries: Entry[]) => void; onDelete: (entries: Entry[]) => void; onDropMove: (entry: Entry, directory: string) => Promise<void>; onNotice: (message: string) => void; disabled: boolean }
type TreeProps = ExplorerProps & { selection: { visible: boolean; touchMode: boolean; entries: Map<string, Entry>; choose: (entry: Entry, modifiers: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>) => boolean; context: (entry: Entry) => void; touch: (entry: Entry) => void; clear: () => void; collapse: (path: string) => void; copy: (entries: Entry[]) => Promise<void> } }
export function Explorer(props: ExplorerProps) {
  const client = useQueryClient()
  const nav = useRef<HTMLElement>(null), anchor = useRef<string | null>(null)
  const [selected, setSelected] = useState(new Map<string, Entry>())
  const [touchMode, setTouchMode] = useState(false), [extended, setExtended] = useState(false)
  if (touchMode && selected.size === 0) setTouchMode(false)
  const showSelection = touchMode || extended
  const [copyFallback, setCopyFallback] = useState('')
  useEffect(() => client.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || !['success', 'error'].includes(event.action.type) || event.query.queryKey[0] !== 'tree' || typeof event.query.queryKey[1] !== 'string') return
    const directory = event.query.queryKey[1], data = event.query.state.data as InfiniteData<Awaited<ReturnType<typeof api.tree>>> | undefined
    if (event.action.type === 'success' && !data?.pages) return
    const snapshot = event.action.type === 'error' ? null : data!.pages.flatMap(page => page.entries)
    setSelected(current => reconcileEntrySelection(current, directory, snapshot))
    if (event.action.type === 'error') anchor.current = null
  }), [client])
  const clear = () => { setSelected(new Map()); setExtended(false); setTouchMode(false); anchor.current = null }
  const toggle = (entry: Entry) => { anchor.current = entry.path; if (touchMode && selected.size === 1 && selected.has(entry.path)) setTouchMode(false); setSelected(current => { const next = new Map(current); if (next.has(entry.path)) next.delete(entry.path); else next.set(entry.path, entry); return next }) }
  const range = (entry: Entry, additive = false) => {
    const entries = new Map<string, Entry>()
    for (const [, data] of client.getQueriesData<InfiniteData<Awaited<ReturnType<typeof api.tree>>>>({ queryKey: ['tree'] })) {
      for (const page of data?.pages ?? []) for (const value of page.entries) entries.set(value.path, value)
    }
    const visible = [...(nav.current?.querySelectorAll<HTMLButtonElement>('[data-entry-path]') ?? [])].flatMap(row => { const value = entries.get(row.dataset.entryPath ?? ''); return value ? [value] : [] })
    const choices = entryRange(visible, anchor.current, entry)
    setSelected(current => { const next = additive ? new Map(current) : new Map<string, Entry>(); for (const value of choices) next.set(value.path, value); return next })
    setExtended(true)
  }
  const selection: TreeProps['selection'] = {
    visible: showSelection, touchMode, entries: selected, clear,
    choose: (entry, event) => {
      if (event.shiftKey) { range(entry, event.ctrlKey || event.metaKey); return true }
      anchor.current = entry.path
      if (event.ctrlKey || event.metaKey || touchMode) { toggle(entry); if (!touchMode) setExtended(true); return true }
      setSelected(new Map([[entry.path, entry]])); setExtended(false); return false
    },
    context: entry => { if (!selected.has(entry.path)) { setSelected(new Map([[entry.path, entry]])); anchor.current = entry.path } },
    touch: entry => { setTouchMode(true); setExtended(false); if (!selected.has(entry.path)) { setSelected(new Map([[entry.path, entry]])); anchor.current = entry.path } },
    collapse: path => { setSelected(current => new Map([...current].filter(([key]) => !key.startsWith(`${path}/`)))); if (anchor.current?.startsWith(`${path}/`)) anchor.current = path },
    copy: async entries => { const paths = entries.map(entry => entry.path).join('\n'); try { await navigator.clipboard.writeText(paths); props.onNotice('相对路径已复制') } catch { setCopyFallback(paths); props.onNotice('复制失败，可在弹窗中手动复制路径') } },
  }
  const treeProps = { ...props, selection, onCreate: (kind: 'file' | 'directory', directory: string) => { clear(); props.onCreate(kind, directory) } }
  return <EntryDragProvider disabled={props.disabled} onMove={props.onDropMove} onNotice={props.onNotice} onDirectory={props.setDirectory}><nav ref={nav} className={`explorer-tree ${showSelection ? 'selection-visible' : ''}`} aria-label="工作区文件" onPointerDown={event => { if (event.target instanceof Element && !event.target.closest('button,input,form,[role="menu"]')) clear() }} onKeyDown={(event) => {
    if (!(event.target instanceof HTMLElement) || !event.currentTarget.contains(event.target)) return
    if (event.key === 'Escape' && selection.visible) { event.preventDefault(); clear(); focusEntry(nav.current, event.target.dataset.entryPath ?? ''); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && event.target.matches('[data-entry-path]')) {
      event.preventDefault(); const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-entry-path]')].filter(row => !!row.dataset.entryPath)
      if (rows.length) { const first = rows[0].dataset.entryPath!, last = rows.at(-1)!.dataset.entryPath!; anchor.current = first; const data = client.getQueryData<InfiniteData<Awaited<ReturnType<typeof api.tree>>>>(['tree', last.split('/').slice(0, -1).join('/')]); const entry = data?.pages.flatMap(page => page.entries).find(value => value.path === last); if (entry) range(entry) }
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-entry-path]') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-entry-path]')]
    const current = rows.indexOf(event.target as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
    const target = rows[next]
    target?.focus()
    if (event.shiftKey && target?.dataset.entryPath) { const path = target.dataset.entryPath; const data = client.getQueryData<InfiniteData<Awaited<ReturnType<typeof api.tree>>>>(['tree', path.split('/').slice(0, -1).join('/')]); const entry = data?.pages.flatMap(page => page.entries).find(value => value.path === path); if (entry) { if (!anchor.current) anchor.current = event.target.dataset.entryPath || path; range(entry) } }
  }}><RootFolder {...treeProps} /><FolderContents {...treeProps} path="" depth={0} /><NewEntryMenu directory={props.directory} onCreate={treeProps.onCreate}><div className="explorer-empty-space" aria-hidden="true" onContextMenu={() => clear()} /></NewEntryMenu></nav><Dialog.Root open={!!copyFallback} onOpenChange={open => { if (!open) setCopyFallback('') }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><DialogContent className="dialog-content"><Dialog.Title>复制相对路径</Dialog.Title><Dialog.Description>剪贴板不可用，请手动复制以下工作区相对路径。</Dialog.Description><label htmlFor="copy-entry-path">相对路径</label><textarea id="copy-entry-path" readOnly value={copyFallback} autoFocus onFocus={event => event.target.select()} /><div className="dialog-actions"><Dialog.Close asChild><Button>关闭</Button></Dialog.Close></div></DialogContent></Dialog.Portal></Dialog.Root></EntryDragProvider>
}
function NewEntryMenu({ directory, onCreate, children }: { directory: string; onCreate: ExplorerProps['onCreate']; children: ReactElement }) {
  return <ContextMenu.Root><ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content className="context-menu"><ContextMenu.Label className="tree-menu-label">创建位置：{directory || '工作区根目录'}</ContextMenu.Label><ContextMenu.Item onSelect={() => onCreate('file', directory)}>新建笔记</ContextMenu.Item><ContextMenu.Item onSelect={() => onCreate('directory', directory)}>新建文件夹</ContextMenu.Item></ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root>
}
function RootFolder(props: TreeProps) {
  const drag = useEntryDrag()
  return <NewEntryMenu directory="" onCreate={props.onCreate}><button data-entry-path="" onContextMenu={event => { event.stopPropagation(); props.selection.clear() }} className={`folder-label root-folder ${props.directory === '' ? 'directory-selected' : ''} ${drag.target === '' ? 'drop-target' : ''}`} onClick={() => { props.selection.clear(); props.setDirectory('') }} onDragOver={(event) => drag.over(event, '')} onDragLeave={drag.leave} onDrop={(event) => drag.drop(event, '')}><FolderIcon expanded />工作区</button></NewEntryMenu>
}
function FolderContents(props: TreeProps & { path: string; depth: number }) {
  const query = useInfiniteQuery({ queryKey: ['tree', props.path], queryFn: ({ pageParam }) => api.tree(props.path, pageParam), initialPageParam: 0, getNextPageParam: (last) => last.offset + last.entries.length < last.total ? last.offset + last.entries.length : undefined, staleTime: 30_000, retry: false })
  if (query.isPending) return <p className="tree-message" role="status">正在读取…</p>
  if (query.error) return <div className="tree-message" role="alert">{query.error.message}<Button onClick={() => void query.refetch()}>重试</Button></div>
  const entries = query.data.pages.flatMap((page) => page.entries)
  return <>{entries.map((entry) => <EntryRow {...props} key={entry.path} entry={entry} />)}
    {entries.length === 0 && <NewEntryMenu directory={props.path} onCreate={props.onCreate}><p className="tree-message" onContextMenu={() => props.selection.clear()}>{props.path ? '此目录还没有文件' : '工作区为空，创建一篇笔记吧。'}</p></NewEntryMenu>}
    {query.hasNextPage && <Button onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? '正在读取…' : '加载更多'}</Button>}
  </>
}
function EntryRow({ entry, ...props }: TreeProps & { depth: number; entry: Entry }) {
  const [expanded, setExpanded] = useState(() => window.matchMedia('(max-width: 767px)').matches && (props.directory === entry.path || props.directory.startsWith(`${entry.path}/`) || props.active.startsWith(`${entry.path}/`)))
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [touchInput, setTouchInput] = useState(false)
  const touchPointer = useRef(false), suppressClick = useRef(false), selectionGesture = useRef(false)
  const [renaming, setRenaming] = useState(false)
  const [renameEntry, setRenameEntry] = useState(entry)
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
  const startRename = () => { setRenameEntry({ ...entry }); setName(entry.name); setError(''); setRenaming(true) }
  const selected = props.selection.entries.has(entry.path)
  const choices = selected ? [...props.selection.entries.values()] : [entry]
  const toggleExpanded = () => { if (expanded) props.selection.collapse(entry.path); setExpanded(!expanded); props.setDirectory(entry.path) }
  const changeContext = (open: boolean) => {
    if (open && touchPointer.current) {
      suppressClick.current = true
      props.selection.touch(entry)
      // 首次长按只进入选择，随后点按增减；再次长按打开整组操作菜单。
      if (!props.selection.touchMode || selectionGesture.current) { selectionGesture.current = true; setContextOpen(false); return }
    }
    setContextOpen(open)
  }
  const actions = (context: boolean) => {
    const Item = context ? ContextMenu.Item : Menu.Item, Separator = context ? ContextMenu.Separator : Menu.Separator, Label = context ? ContextMenu.Label : Menu.Label
    return <>{props.selection.visible && <><Label className="tree-menu-label">已选 {choices.length} 项</Label><Item onSelect={props.selection.clear}>取消选择</Item><Separator /></>}{directory && <><Item onSelect={() => { setExpanded(true); props.onCreate('file', entry.path) }}>新建笔记</Item><Item onSelect={() => { setExpanded(true); props.onCreate('directory', entry.path) }}>新建文件夹</Item><Separator /></>}<Item onSelect={() => void props.selection.copy(choices)}>复制相对路径</Item><Item disabled={choices.length !== 1 || props.disabled} onSelect={startRename}>重命名</Item><Item disabled={props.disabled} onSelect={() => props.onMove(choices)}>移动到…</Item><Separator /><Item disabled={props.disabled} className="destructive" onSelect={() => props.onDelete(choices)}>移到回收站</Item></>
  }
  return <div>
    <ContextMenu.Root open={contextOpen} onOpenChange={changeContext}><ContextMenu.Trigger asChild disabled={renaming}><div className={`tree-entry ${props.active === entry.path ? 'selected' : ''} ${props.selection.visible && selected ? 'multi-selected' : ''}`} onPointerDownCapture={event => { touchPointer.current = (event.pointerType === 'touch' || event.pointerType === 'pen') && event.target instanceof Element && !!event.target.closest('[data-entry-path]'); setTouchInput(touchPointer.current); suppressClick.current = false; selectionGesture.current = false }} onContextMenu={(event) => { event.stopPropagation(); if (!renaming && !touchPointer.current) props.selection.context(entry) }}>
      {renaming ? <form className="inline-rename" onSubmit={async (event) => {
        event.preventDefault(); setError('')
        const nav = event.currentTarget.closest('nav')
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) { setError('请输入不含路径分隔符的文件名'); return }
        if (name === entry.name) { setRenaming(false); focusEntry(nav, entry.path); return }
        setBusy(true)
        try { await props.onRename(renameEntry, name); setRenaming(false); const parent = entry.path.split('/').slice(0, -1).join('/'); const destination = parent ? `${parent}/${name}` : name; focusEntry(nav, destination) } catch (problem) { setError(problem instanceof Error ? problem.message : '重命名失败') } finally { setBusy(false) }
      }}><input aria-label={`重命名 ${entry.name}`} value={name} disabled={busy} maxLength={255} autoFocus onFocus={(event) => { const dot = !directory ? name.lastIndexOf('.') : -1; event.target.setSelectionRange(0, dot > 0 ? dot : name.length) }} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); setRenaming(false); focusEntry(event.currentTarget.closest('nav'), entry.path) } }} /><Button size="icon" type="submit" aria-label="确认重命名" disabled={busy}><Check size={13} /></Button><Button size="icon" type="button" aria-label="取消重命名" disabled={busy} onClick={(event) => { setRenaming(false); focusEntry(event.currentTarget.closest('nav'), entry.path) }}><X size={13} /></Button></form> : <>
        {directory && <button className="entry-expander" style={{ left: 4 + props.depth * 14 }} aria-label={`${expanded ? '收起' : '展开'} ${entry.name}`} onPointerDown={event => event.stopPropagation()} onClick={toggleExpanded}><ChevronRight size={13} className={expanded ? 'expanded' : ''} /></button>}
        <button data-entry-path={entry.path} draggable={!touchInput && !props.disabled && !drag.busy && !busy && !(selected && choices.length > 1)} onDragStart={(event) => { props.selection.context(entry); drag.start(event, entry) }} onDragEnd={drag.end} onDragOver={directory ? (event) => drag.over(event, entry.path) : undefined} onDragLeave={directory ? drag.leave : undefined} onDrop={directory ? (event) => { if (drag.drop(event, entry.path)) setExpanded(true) } : undefined} onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return
          if (event.key === 'F2') { event.preventDefault(); if (choices.length === 1) { props.selection.context(entry); startRename() } }
          if (event.key === 'Delete') { event.preventDefault(); props.onDelete(choices) }
          if (event.shiftKey && event.key === 'F10') { event.preventDefault(); props.selection.context(entry); setMenuOpen(true) }
          if (event.key === 'ArrowRight' && directory) { event.preventDefault(); if (!expanded) setExpanded(true); else [...event.currentTarget.closest('nav')!.querySelectorAll<HTMLButtonElement>('[data-entry-path]')].find((row) => row.dataset.entryPath?.startsWith(`${entry.path}/`))?.focus() }
          else if (event.key === 'ArrowLeft') { event.preventDefault(); if (directory && expanded) { setExpanded(false); props.selection.collapse(entry.path) } else { const parent = entry.path.split('/').slice(0, -1).join('/'); [...event.currentTarget.closest('nav')!.querySelectorAll<HTMLButtonElement>('[data-entry-path]')].find((row) => row.dataset.entryPath === parent)?.focus() } }
        }} className={`file-row ${directory ? 'folder-row' : ''} ${drag.target === entry.path ? 'drop-target' : ''} ${drag.entry?.path === entry.path ? 'drag-source' : ''} ${props.active === entry.path ? 'selected' : ''} ${directory && props.directory === entry.path ? 'directory-selected' : ''}`} style={{ paddingLeft: (directory ? 24 : 16) + props.depth * 14 }} aria-current={props.active === entry.path ? 'page' : undefined} aria-pressed={props.selection.visible ? selected : undefined} aria-expanded={directory ? expanded : undefined} onClick={event => { const ignore = suppressClick.current && event.detail > 0; suppressClick.current = false; if (ignore) { event.preventDefault(); return } if (props.selection.choose(entry, event)) return; if (directory) toggleExpanded(); else props.onOpen(entry.path) }} title={entry.path}>{directory ? <FolderIcon path={entry.path} expanded={expanded} /> : <FileIcon path={entry.path} />}<span>{entry.name}</span></button>
        <Menu.Root open={menuOpen} onOpenChange={open => { if (open) props.selection.context(entry); setMenuOpen(open) }}><Menu.Trigger asChild><Button className="entry-menu-trigger" size="icon" aria-label={`文件操作 ${entry.name}`} title="文件操作" onPointerDown={event => event.stopPropagation()}><MoreHorizontal size={15} /></Button></Menu.Trigger><Menu.Portal><Menu.Content className="context-menu" align="end" sideOffset={4}>{actions(false)}</Menu.Content></Menu.Portal></Menu.Root>
      </>}
    </div></ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content className="context-menu">{actions(true)}</ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root>
    {error && renaming && <p className="tree-message form-error" role="alert">{error}</p>}
    {directory && expanded && <FolderContents {...props} path={entry.path} depth={props.depth + 1} />}
  </div>
}
