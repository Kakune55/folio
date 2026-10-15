export class ApiError extends Error {
  status: number
  code: string
  details?: Record<string, string>
  constructor(status: number, code: string, message: string, details?: Record<string, string>) { super(message); this.status = status; this.code = code; this.details = details }
}
export type Principal = { username: string; csrfToken: string }
export type FileContent = { path: string; content: string; revision: string; size: number; encoding: string; mtime: string; kind: string }
export type Entry = { name: string; path: string; kind: 'directory' | 'file'; size: number }
export type TreePage = { entries: Entry[]; total: number; offset: number; limit: number }
let csrf = ''
export function setCSRF(token: string) { csrf = token }
export async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${url}`, { ...init, credentials: 'same-origin', headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.method && !['GET', 'HEAD'].includes(init.method) ? { 'X-CSRF-Token': csrf } : {}), ...init.headers } })
  if (!response.ok) {
    const problem = await response.json().catch(() => ({ error: { code: 'http_error', message: `请求失败（${response.status}）` } }))
    if (response.status === 401 && url !== '/auth/login') window.dispatchEvent(new Event('folio:unauthenticated'))
    throw new ApiError(response.status, problem.error?.code ?? 'http_error', problem.error?.message ?? '请求失败', problem.error?.details)
  }
  return response.json() as Promise<T>
}
export const api = {
  me: () => request<Principal>('/auth/me'),
  login: async (username: string, password: string) => { const principal = await request<Principal>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }); setCSRF(principal.csrfToken); return principal },
  logout: () => request('/auth/logout', { method: 'POST' }),
  tree: (path: string, offset = 0) => request<TreePage>(`/workspace/tree?path=${encodeURIComponent(path)}&offset=${offset}`),
  read: (path: string) => request<FileContent>(`/files/content?path=${encodeURIComponent(path)}`),
  write: (path: string, content: string, revision: string) => request<{ revision: string }>(`/files/content?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: { 'If-Match': `"${revision}"` }, body: JSON.stringify({ content, encoding: 'utf-8' }) }),
  create: (path: string, content = '') => request<{ path: string; revision: string }>('/files', { method: 'POST', headers: { 'If-None-Match': '*' }, body: JSON.stringify({ path, content, encoding: 'utf-8' }) }),
  createCopy: async (path: string, content: string) => {
    const copyPath = path.replace(/(\.[^/.]+)?$/, `.本地-${crypto.randomUUID().slice(0, 12)}$1`)
    return request<{ path: string; revision: string }>('/files', { method: 'POST', headers: { 'If-None-Match': '*' }, body: JSON.stringify({ path: copyPath, content, encoding: 'utf-8' }) })
  },
  mkdir: (path: string) => request('/directories', { method: 'POST', body: JSON.stringify({ path }) }),
}
export function downloadDraft(path: string, source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = path.split('/').at(-1) ?? path; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
