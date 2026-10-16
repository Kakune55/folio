import { useSyncExternalStore } from 'react'
import { Button } from '../../components/ui/button'
import { downloadUpload, uploadQueue } from '../../sessions/uploads'
import type { PendingUpload } from '../../sessions/uploads'

export function UploadFailures({ busy, onRetry, onDiscard }: { busy: boolean; onRetry: (entries: PendingUpload[]) => void; onDiscard: (entry: PendingUpload) => void }) {
  const failed = useSyncExternalStore(uploadQueue.subscribe, uploadQueue.snapshot).filter((entry) => entry.state === 'failed')
  if (!failed.length) return null
  return <div className="upload-failures" role="alert"><p>{failed.length} 个附件尚未确认上传。原件暂存在当前页面，刷新前请重试或下载；先检查目录是否已有同名文件。</p>{failed.map((entry) => <div className="upload-failure" key={entry.id}><span>{entry.file.name}：{entry.error}</span><Button aria-label={`下载待上传原件 ${entry.file.name}`} onClick={() => downloadUpload(entry.file)}>下载原件</Button><Button aria-label={`移除待上传原件 ${entry.file.name}`} disabled={busy} onClick={() => onDiscard(entry)}>移除…</Button></div>)}<Button variant="outline" disabled={busy} onClick={() => onRetry(failed)}>重试到当前目录</Button></div>
}
