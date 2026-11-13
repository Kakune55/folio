import { useEffect } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { ArrowUp, ChevronRight, RefreshCw } from 'lucide-react'
import { api } from '../../services/api'
import type { Entry } from '../../services/api'
import { FolderIcon } from './FileIcon'

// eslint-disable-next-line react/only-export-components -- 禁区纯函数供定向测试使用，避免引入额外文件。
export function isDirectoryForbidden(directory: string, entries: Entry[]) {
  return entries.some(entry => entry.kind === 'directory' && (directory === entry.path || directory.startsWith(`${entry.path}/`)))
}

export function DirectoryPicker({ directory, entries, disabled, onChange, onReadyChange }: {
  directory: string
  entries: Entry[]
  disabled: boolean
  onChange: (path: string) => void
  onReadyChange: (ready: boolean) => void
}) {
  const forbidden = isDirectoryForbidden(directory, entries)
  const query = useInfiniteQuery({
    queryKey: ['move-directories', directory],
    queryFn: ({ pageParam }) => api.tree(directory, pageParam),
    initialPageParam: 0,
    getNextPageParam: last => last.offset + last.entries.length < last.total ? last.offset + last.entries.length : undefined,
    enabled: !forbidden && !disabled,
    retry: false,
  })
  const ready = !disabled && !forbidden && query.isSuccess && query.fetchStatus === 'idle'
  useEffect(() => { onReadyChange(ready) }, [directory, onReadyChange, ready])

  const parts = directory ? directory.split('/') : []
  const parent = parts.slice(0, -1).join('/')
  const directories = query.data?.pages.flatMap(page => page.entries).filter(entry => entry.kind === 'directory') ?? []
  return <fieldset className="directory-picker" disabled={disabled}>
    <legend className="visually-hidden">目标文件夹</legend>
    <div className="directory-picker-toolbar">
      <button type="button" className="directory-picker-icon" aria-label="返回上级目录" title="返回上级目录" disabled={disabled || !directory} onClick={() => onChange(parent)}><ArrowUp size={16} aria-hidden="true" /></button>
      <nav className="directory-picker-breadcrumb" aria-label="目标目录路径">
        <button type="button" aria-label="工作区根目录" aria-current={!directory ? 'location' : undefined} onClick={() => onChange('')}>工作区</button>
        {parts.map((part, index) => {
          const path = parts.slice(0, index + 1).join('/')
          return <span className="directory-picker-crumb" key={path}>
            <span aria-hidden="true">/</span>
            <button type="button" title={path} disabled={disabled || isDirectoryForbidden(path, entries)} aria-current={path === directory ? 'location' : undefined} onClick={() => onChange(path)}>{part}</button>
          </span>
        })}
      </nav>
      <button type="button" className="directory-picker-icon" aria-label="刷新目标目录" title="刷新目标目录" disabled={disabled || forbidden} aria-disabled={query.isFetching || undefined} onClick={() => { if (!query.isFetching) void query.refetch() }}><RefreshCw size={16} aria-hidden="true" /></button>
    </div>
    <div className="directory-picker-browser">
      {forbidden ? <p className="directory-picker-error" role="alert">不能移动到自身或子目录，请返回上级。</p> : <>
        {query.isFetching && <p className="directory-picker-status" role="status">{query.isFetchingNextPage ? '正在加载更多目录…' : '正在读取目标目录…'}</p>}
        {query.fetchStatus === 'paused' && <p className="directory-picker-status" role="status">网络已暂停，等待连接后读取目录。</p>}
        {query.isError && <div className="directory-picker-error" role="alert">
          <p>读取目标目录失败：{query.error.message}</p>
          <button type="button" disabled={disabled || query.isFetching} onClick={() => { if (query.isFetchNextPageError) void query.fetchNextPage(); else void query.refetch() }}>重试</button>
        </div>}
        <ul className="directory-picker-list" tabIndex={0} aria-label="可浏览的目标目录" aria-busy={query.isFetching}>
          {directories.map(entry => <li key={entry.path}>
            <button type="button" className="directory-picker-row" aria-label={`进入目录 ${entry.path}`} title={entry.path} disabled={disabled || isDirectoryForbidden(entry.path, entries)} onClick={() => onChange(entry.path)}>
              <FolderIcon path={entry.path} /><span>{entry.name}</span><ChevronRight size={16} aria-hidden="true" />
            </button>
          </li>)}
        </ul>
        {query.isSuccess && !query.isFetching && directories.length === 0 && <p className="directory-picker-status" role="status">{query.hasNextPage ? '暂无文件夹，可继续加载' : '没有子文件夹'}</p>}
        {query.hasNextPage && <button type="button" className="directory-picker-more" disabled={disabled || query.isFetching} onClick={() => void query.fetchNextPage()}>更多目录</button>}
      </>}
    </div>
  </fieldset>
}
