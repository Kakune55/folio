import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '../../components/ui/button'
import { api } from '../../services/api'
import type { SystemConfiguration } from '../../services/api'
import { formatBytes } from '../../services/format'

const fields = [
  ['Text', '文本大小上限', 1024 ** 2, 100], ['Image', '图片大小上限', 1024 ** 2, 1024],
  ['PDF', 'PDF 大小上限', 1024 ** 2, 1024], ['Attachment', '附件大小上限', 1024 ** 2, 1024],
  ['ImagePixels', '图片像素上限', 1_000_000, 1000], ['indexLimit', '正文索引上限', 1024 ** 2, 100],
] as const

function ConfigurationForm({ initial }: { initial: SystemConfiguration }) {
  const client = useQueryClient()
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  return <form className="system-form" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try {
      const saved = await api.saveSystemConfiguration(value)
      setValue(saved); setNotice('设置已生效，索引上限变化时将自动重建。')
      await Promise.all(['system-configuration', 'file-index', 'search', 'search-status'].map((key) => client.invalidateQueries({ queryKey: [key] })))
    } catch (e) { setError(e instanceof Error ? e.message : '设置保存失败，请重试') }
    finally { setBusy(false) }
  }}>
    {fields.map(([key, label, scale, max]) => <div className="system-field" key={key}>
      <label htmlFor={`setting-${key}`}>{label}</label><div className="system-number"><input id={`setting-${key}`} type="number" min={1 / scale} max={max} step="any" required disabled={busy}
        value={(key === 'indexLimit' ? value.indexLimit : value.limits[key]) / scale}
        onChange={(event) => { const number = Math.round(Number(event.target.value) * scale); setValue((old) => key === 'indexLimit' ? { ...old, indexLimit: number } : { ...old, limits: { ...old.limits, [key]: number } }) }} /><span>{key === 'ImagePixels' ? '百万像素' : 'MiB'}</span></div>
    </div>)}
    {error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <Button variant="outline" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存设置'}</Button>
  </form>
}

export function SystemConfigurationPanel() {
  const query = useQuery({ queryKey: ['system-configuration'], queryFn: api.systemConfiguration, retry: false })
  return <section className="users-section"><h2>系统设置</h2>
    {query.isPending && <p role="status">正在读取设置…</p>}
    {query.error && <p role="alert">{query.error.message}<Button onClick={() => void query.refetch()}>重试</Button></p>}
    {query.data && <ConfigurationForm initial={query.data} />}
  </section>
}

const duration = (seconds: number) => {
  const n = Math.max(0, Math.floor(seconds))
  return `${Math.floor(n / 86400)} 天 ${Math.floor(n / 3600) % 24} 小时 ${Math.floor(n / 60) % 60} 分 ${n % 60} 秒`
}
export function SystemStatusPanel() {
  const [refresh, setRefresh] = useState(true)
  const status = useQuery({ queryKey: ['system-status'], queryFn: api.systemStatus, refetchInterval: refresh ? 5000 : false, retry: false })
  const disk = useQuery({ queryKey: ['system-disk'], queryFn: api.systemDisk, enabled: false, retry: false })
  const data = status.data
  const mem = data?.memory
  const groups: [string, [string, string | number][]][] = data && mem ? [
    ['运行', [['服务运行时间', duration(data.uptime)], ['Go 版本', data.goVersion], ['运行平台', data.platform], ['逻辑 CPU 数量', data.cpus], ['当前 Goroutines 数量', data.goroutines], ['已打开工作区', data.openWorkspaces], ['已打开工作区索引文件数', data.indexedFiles]]],
    ['内存', [['当前分配内存', formatBytes(mem.Alloc)], ['累计分配内存', formatBytes(mem.TotalAlloc)], ['Go 运行时保留内存', formatBytes(mem.Sys)], ['内存分配次数', mem.Mallocs.toLocaleString()], ['内存释放次数', mem.Frees.toLocaleString()], ['指针查找次数', mem.Lookups.toLocaleString()]]],
    ['Heap 与 Stack', [['Heap 使用量', formatBytes(mem.HeapAlloc)], ['Heap 保留量', formatBytes(mem.HeapSys)], ['Heap 使用中跨度', formatBytes(mem.HeapInuse)], ['Heap 空闲量', formatBytes(mem.HeapIdle)], ['Heap 已归还操作系统', formatBytes(mem.HeapReleased)], ['Heap 对象数量', mem.HeapObjects.toLocaleString()], ['Stack 使用量', formatBytes(mem.StackInuse)], ['Stack 保留量', formatBytes(mem.StackSys)]]],
    ['运行时内部内存', [['MSpan 使用量 / 保留量', `${formatBytes(mem.MSpanInuse)} / ${formatBytes(mem.MSpanSys)}`], ['MCache 使用量 / 保留量', `${formatBytes(mem.MCacheInuse)} / ${formatBytes(mem.MCacheSys)}`], ['分析哈希表', formatBytes(mem.BuckHashSys)], ['GC 元数据', formatBytes(mem.GCSys)], ['其他运行时内存', formatBytes(mem.OtherSys)]]],
    ['GC', [['下次 GC 目标 Heap', formatBytes(mem.NextGC)], ['距上次 GC 时间', mem.NumGC ? duration(data.sinceGC) : '尚未执行'], ['GC 累计暂停', `${(mem.PauseTotalNs / 1e9).toFixed(3)} 秒`], ['上次 GC 暂停', `${(data.lastPauseNs / 1e6).toFixed(3)} ms`], ['GC 执行次数', mem.NumGC.toLocaleString()], ['GC CPU 占比（累计）', `${(mem.GCCPUFraction * 100).toFixed(2)}%`]]],
  ] : []
  return <section className="users-section"><div className="users-heading"><h2>系统状态</h2><div className="system-status-actions"><label><input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} />每 5 秒刷新</label><Button variant="outline" disabled={status.isFetching} onClick={() => void status.refetch()}>刷新状态</Button></div></div>
    {status.isPending && <p role="status">正在读取状态…</p>}{status.error && <p role="alert">{status.error.message}<Button onClick={() => void status.refetch()}>重试</Button></p>}
    {groups.map(([title, rows]) => <div className="system-metrics" key={title}><h3>{title}</h3><dl>{rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></div>)}
    <div className="system-metrics"><div className="users-heading"><h3>磁盘目录用量</h3><Button variant="outline" disabled={disk.isFetching} onClick={() => void disk.refetch()}>{disk.isFetching ? '正在统计…' : '统计磁盘用量'}</Button></div>
      {disk.error && <p role="alert">{disk.error.message}</p>}
      {disk.data && <dl>{(['workspace', 'appData'] as const).map((key) => <div key={key}><dt>{key === 'workspace' ? '全部工作区文件' : '应用数据（含索引与回收站）'}</dt><dd>{formatBytes(disk.data[key].bytes)} · {disk.data[key].files.toLocaleString()} 个文件 · {disk.data[key].directories.toLocaleString()} 个目录<br />{disk.data[key].volumeError ?? `所在磁盘：可用 ${formatBytes(disk.data[key].available)} / 总计 ${formatBytes(disk.data[key].total)}`}</dd></div>)}</dl>}
    </div>
  </section>
}
