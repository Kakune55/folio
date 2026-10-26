import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { formatBytes } from '../../services/format'
import { api } from '../../services/api'
import type { Principal } from '../../services/api'

export function AccountControls({ principal, onSettings }: { principal: Principal; onSettings: () => void }) {
  const usage = useQuery({ queryKey: ['usage', principal.workspaceId], queryFn: api.usage, refetchInterval: 5000, retry: false })
  const percent = usage.data ? usage.data.quota > 0 ? Math.min(100, usage.data.used / usage.data.quota * 100) : usage.data.used > 0 ? 100 : 0 : 0
  return <div className="account-controls">
    <div className="account-row"><span className="account-name">{principal.username}</span><Link to="/user-setting" onClick={onSettings}>用户设置</Link></div>
    {usage.error ? <div role="alert">用量读取失败 <button onClick={() => void usage.refetch()}>重试</button></div> : usage.data ? <div className={`quota-usage ${usage.data.used >= usage.data.quota ? 'quota-full' : ''}`} role="group" aria-label="工作区用量" title="包含文件、附件和回收站"><span>{formatBytes(usage.data.used)} / {formatBytes(usage.data.quota)}{usage.data.used > usage.data.quota ? ' · 已超额' : usage.data.used === usage.data.quota ? ' · 已用满' : usage.data.used >= usage.data.quota * .9 ? ' · 即将用满' : ''}</span><span className="quota-meter" role="progressbar" aria-label="工作区配额使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent * 10) / 10} aria-valuetext={`${formatBytes(usage.data.used)} / ${formatBytes(usage.data.quota)}`}><span style={{ width: `${percent}%` }} /></span></div> : <span role="status">正在读取用量…</span>}
  </div>
}
