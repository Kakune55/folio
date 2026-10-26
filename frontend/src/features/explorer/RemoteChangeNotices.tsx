import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '../../components/ui/button'
import type { RemoteNotice, RemoteNotices } from '../../sessions/remote-notices'
import type { Session } from '../../sessions/workspace'

export function RemoteChangeNotices({ notices, onConflict }: { notices: RemoteNotices; onConflict: (session: Session) => void }) {
  useSyncExternalStore(notices.subscribe, notices.snapshot)
  const [now, setNow] = useState(Date.now)
  const entries = notices.list()
  useEffect(() => {
    const timer = setInterval(() => {
      const time = Date.now(); setNow(time); notices.prune()
      for (const entry of notices.list()) {
        if (entry.deadline === null || entry.busy) continue
        if (entry.session.dirty || ['error', 'conflict'].includes(entry.session.state)) notices.wait(entry)
        else if (entry.deadline <= time) void notices.accept(entry)
      }
    }, 250)
    return () => clearInterval(timer)
  }, [notices])
  const accept = async (entry: RemoteNotice) => { if (await notices.accept(entry) === 'conflict') onConflict(entry.session) }
  return <>
    <section className="remote-notices" aria-label="远程文件修改通知">
      {entries.map(entry => <article className="remote-notice" key={entry.path} aria-label={`远程修改：${entry.path}`}>
        <div className="remote-notice-heading" role="status"><strong>文件已被远程修改</strong><span className="remote-diff-count" aria-label={`差异：新增 ${entry.inserted} 行，删除 ${entry.deleted} 行`}><span className="remote-inserted">+{entry.inserted}</span> <span className="remote-deleted">-{entry.deleted}</span></span></div>
        <p className="remote-notice-path" title={entry.path}>{entry.path}</p>
        <p className="remote-notice-source">{entry.source ? `来自应用 ${entry.source}` : '来自外部修改（来源未确认）'}</p>
        {entry.limited && <p className="remote-notice-source">差异较大，增删统计为近似值。</p>}
        {entry.session.dirty && <p className="remote-notice-source">本地草稿已保留，接受前需比较版本。</p>}
        {entry.error && <p className="form-error" role="alert">{entry.error}</p>}
        <div className="remote-notice-actions"><Button variant="outline" disabled={entry.busy} onClick={() => void accept(entry)}>接受{entry.deadline !== null && `（${Math.min(10, Math.max(0, Math.ceil((entry.deadline - now) / 1000)))}s）`}</Button>{entry.deadline !== null && <Button disabled={entry.busy} onClick={() => notices.wait(entry)}>等待</Button>}<Button disabled={entry.busy} title="使用条件写入恢复本轮修改前的磁盘正文，不覆盖后续版本" onClick={() => void notices.rollback(entry)}>{entry.busy ? '正在处理…' : '回滚'}</Button></div>
      </article>)}
    </section>
  </>
}
