import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { api } from '../../services/api'

export function Explorer({ active, directory, setDirectory, onOpen }: { active: string; directory: string; setDirectory: (path: string) => void; onOpen: (path: string) => void }) {
  return <nav aria-label="工作区文件"><FolderContents path="" depth={0} active={active} directory={directory} setDirectory={setDirectory} onOpen={onOpen} /></nav>
}
function FolderContents({ path, depth, active, directory, setDirectory, onOpen }: { path: string; depth: number; active: string; directory: string; setDirectory: (path: string) => void; onOpen: (path: string) => void }) {
  const query = useInfiniteQuery({ queryKey: ['tree', path], queryFn: ({ pageParam }) => api.tree(path, pageParam), initialPageParam: 0, getNextPageParam: (last) => last.offset + last.entries.length < last.total ? last.offset + last.entries.length : undefined, staleTime: 30_000, retry: false })
  if (query.isPending) return <p className="tree-message" role="status">正在读取…</p>
  if (query.error) return <div className="tree-message" role="alert">{query.error.message}<Button onClick={() => void query.refetch()}>重试</Button></div>
  const entries = query.data.pages.flatMap((page) => page.entries)
  return <>{entries.map((entry) => entry.kind === 'directory' ? <FolderRow key={entry.path} path={entry.path} name={entry.name} depth={depth} active={active} directory={directory} setDirectory={setDirectory} onOpen={onOpen} /> : <button key={entry.path} className={`file-row ${active === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 16 + depth * 14 }} aria-current={active === entry.path ? 'page' : undefined} onClick={() => onOpen(entry.path)} title={entry.path}><FileText size={16} /><span>{entry.name}</span></button>)}
    {entries.length === 0 && <p className="tree-message">{path ? '此目录还没有文件' : '工作区为空，创建一篇笔记吧。'}</p>}
    {query.hasNextPage && <Button onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? '正在读取…' : '加载更多'}</Button>}
  </>
}
function FolderRow(props: { path: string; name: string; depth: number; active: string; directory: string; setDirectory: (path: string) => void; onOpen: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  return <div><button className={`file-row folder-row ${props.directory === props.path ? 'directory-selected' : ''}`} style={{ paddingLeft: 4 + props.depth * 14 }} aria-expanded={expanded} onClick={() => { setExpanded(!expanded); props.setDirectory(props.path) }} title={props.path}><ChevronRight size={13} className={expanded ? 'expanded' : ''} />{expanded ? <FolderOpen size={16} /> : <Folder size={16} />}<span>{props.name}</span></button>
    {expanded && <FolderContents {...props} depth={props.depth + 1} />}
  </div>
}
