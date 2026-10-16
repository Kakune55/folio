import { useQuery } from '@tanstack/react-query'
import { api } from '../../services/api'
import { formatBytes } from '../../services/format'
import type { Session } from '../../sessions/workspace'

const labels = { indexed: '正文已索引', names_only: '仅名称索引', too_large: '正文超限', pending: '索引更新中…', not_indexed: '正文未索引', error: '索引异常' }

export function FileStatus({ session, onSearch }: { session: Session; onSearch: () => void }) {
  const { path, revision } = session
  const result = useQuery({
    queryKey: ['file-index', path, revision],
    queryFn: ({ signal }) => api.fileIndexStatus(path, revision, signal),
    retry: false,
    refetchInterval: (query) => query.state.data?.state === 'pending' ? 500 : false,
  })
  const data = result.data
  const size = data?.size ?? session.metadata?.size
  const label = result.error ? '索引状态不可用' : session.external ? '索引可能过时' : session.dirty ? '待保存后索引' : data ? labels[data.state] : '正在检查索引…'
  const detail = result.error ? `${result.error.message}；点击打开搜索，可重建索引。` : data?.state === 'too_large' ? `正文超过索引上限 ${formatBytes(data.bodyLimit)}，仅搜索名称和路径。` : data?.state === 'names_only' ? '此文件不支持正文索引，仅搜索名称和路径。' : session.dirty ? '当前显示磁盘文件大小，未保存正文尚未进入索引。' : '索引状态对应已保存的磁盘文件；点击打开搜索。'
  return <div className="file-status"><span className="file-size" aria-label="磁盘文件大小" title="磁盘文件大小">{size === undefined ? '—' : formatBytes(size)}</span><button type="button" className="file-index-state" onClick={onSearch} title={detail}>{label}</button></div>
}
