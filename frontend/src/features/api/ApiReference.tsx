import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { SettingsHeader } from '../auth/SettingsHeader'
import { request } from '../../services/api'
import type { Principal } from '../../services/api'
import { Button } from '../../components/ui/button'

type Schema = { $ref?: string; type?: string; format?: string; [key: string]: unknown }
type Parameter = { name: string; in: string; required: boolean; description: string; schema: Schema }
type Media = { schema: Schema; example?: unknown }
type Operation = {
  operationId: string; summary: string; description: string; tags: string[]
  'x-folio-permissions'?: Record<string, string>; security?: unknown[]
  parameters?: Parameter[]; requestBody?: { content: Record<string, Media> }
  responses: Record<string, { $ref?: string; description?: string; content?: Record<string, Media> }>
}
type Specification = {
  info: { title: string; description: string }; tags: { name: string }[]
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, Schema>; responses: Record<string, { description: string; content?: Record<string, Media> }> }
}
const groupNames: Record<string, string> = { files: '文件', search: '搜索', trash: '回收站' }
function permissionLabel(operation: Operation) {
  if (operation.security?.length === 0) return '公开接口'
  const entries = Object.entries(operation['x-folio-permissions'] ?? {})
  return entries.length ? entries.map(([key, value]) => `${groupNames[key]}${value === 'write' ? '读写' : '只读'}`).join(' + ') : '有效 Access Token'
}
function schemaText(schema: Schema, spec: Specification) {
  if (schema.$ref) return JSON.stringify(spec.components.schemas[schema.$ref.split('/').at(-1)!], null, 2)
  return JSON.stringify(schema, null, 2)
}
export function ApiReference({ principal }: { principal: Principal }) {
  const specification = useQuery({ queryKey: ['application-openapi'], queryFn: () => request<Specification>('/openapi.json'), staleTime: Infinity, retry: false })
  const [query, setQuery] = useState('')
  const spec = specification.data
  const operations = spec ? Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => ({ path, method: method.toUpperCase(), operation }))).filter(({ path, method, operation }) => `${path} ${method} ${operation.summary}`.toLowerCase().includes(query.toLowerCase())) : []
  return <main className="settings-page api-reference"><SettingsHeader principal={principal} page="api" />
    <div className="api-reference-content"><header className="api-reference-title"><div><h1>应用 API</h1><p>通过 HTTP API 使用自己的文件、搜索和回收站。</p></div><a href="/api/v1/openapi.json" download="folio-openapi.json">下载 OpenAPI</a></header>
      <section className="api-connection" aria-labelledby="api-connection-heading"><h2 id="api-connection-heading">开始接入</h2><p>基础地址：<code>{window.location.origin}/api/v1</code></p><p>在<Link to="/user-setting?tab=applications">应用设置</Link>生成令牌，使用请求头传递。先查询当前身份和授权：</p><pre tabIndex={0}>{'curl --fail-with-body \\\n  -H "Authorization: Bearer $FOLIO_ACCESS_TOKEN" \\\n  "$FOLIO_URL/api/v1/application"'}</pre><p>将 <code>FOLIO_URL</code> 配置为站点地址，<code>FOLIO_ACCESS_TOKEN</code> 从安全凭据配置读取。令牌权限覆盖本人整个工作区，默认只读。此页面仅提供说明，不发送文件操作请求。</p><p>修改、移动或回收前读取版本，将响应 <code>ETag</code> 原样放入 <code>If-Match</code>。遇到 <code>412</code> 保留候选内容并重新读取比较；请求超时或 <code>durability_uncertain</code> 时先核对结果。新建与上传始终不覆盖同名文件。</p></section>
      {specification.isPending && <p role="status">正在加载接口说明…</p>}{specification.error && <p role="alert">接口说明加载失败：{specification.error.message} <Button onClick={() => void specification.refetch()}>重试</Button></p>}
      {spec && <><label className="api-filter">筛选接口<input value={query} onChange={e => setQuery(e.target.value)} placeholder="输入路径、方法或功能" /></label><p className="setting-description">{operations.length} 个接口 · Bearer 请求无需 CSRF；浏览器 Cookie 仍遵循原有来源与 CSRF 校验。权限“读写”包含“只读”。</p>
        {spec.tags.map(tag => {
          const entries = operations.filter(({ operation }) => operation.tags.includes(tag.name))
          return entries.length > 0 && <section key={tag.name} className="api-reference-group" aria-labelledby={`api-group-${tag.name}`}><h2 id={`api-group-${tag.name}`}>{tag.name}</h2>{entries.map(({ path, method, operation }) => <details key={operation.operationId} id={operation.operationId} className="api-operation"><summary><span className="api-method">{method}</span><code>{path}</code><span className="api-operation-title">{operation.summary}</span></summary><div className="api-operation-body"><p>{operation.description}</p><p className="api-permission">权限：{permissionLabel(operation)}</p>
            {operation.parameters && <div className="api-table-scroll" tabIndex={0} role="region" aria-label="请求参数表"><table><caption>请求参数</caption><thead><tr><th>参数</th><th>位置</th><th>要求</th><th>说明</th></tr></thead><tbody>{operation.parameters.map(p => <tr key={`${p.in}-${p.name}`}><td><code>{p.name}</code></td><td>{p.in}</td><td>{p.required ? '必填' : '可选'}</td><td>{p.description}<br /><code>{JSON.stringify(p.schema)}</code></td></tr>)}</tbody></table></div>}
            {operation.requestBody && <><h3>请求正文</h3>{Object.entries(operation.requestBody.content).map(([media, body]) => <div key={media}><p><code>{media}</code></p><pre tabIndex={0}>{JSON.stringify(body.example ?? body.schema, null, 2)}</pre></div>)}</>}
            <h3>响应</h3>{Object.entries(operation.responses).map(([status, raw]) => {
              const response = raw.$ref ? spec.components.responses[raw.$ref.split('/').at(-1)!] : raw
              return <details className="api-response" key={status}><summary><code>{status}</code> {response.description}</summary>{response.content && Object.entries(response.content).map(([media, body]) => <div key={media}><p><code>{media}</code></p><pre tabIndex={0}>{schemaText(body.schema, spec)}</pre></div>)}</details>
            })}
          </div></details>)}</section>
        })}
        {operations.length === 0 && <p role="status">没有匹配的接口。</p>}
        <details className="api-schema-index"><summary>数据结构</summary>{Object.entries(spec.components.schemas).map(([name, schema]) => <details className="api-response" key={name}><summary>{name}</summary><pre tabIndex={0}>{JSON.stringify(schema, null, 2)}</pre></details>)}</details>
      </>}
    </div>
  </main>
}
