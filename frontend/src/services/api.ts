export class ApiError extends Error {
  status: number
  code: string
  details?: Record<string, string>
  constructor(status: number, code: string, message: string, details?: Record<string, string>) { super(message); this.status = status; this.code = code; this.details = details }
}
export type ViewerKind = 'markdown' | 'text' | 'image' | 'pdf' | 'binary'
export type FileMetadata = { path: string; size: number; mediaType: string; viewer: ViewerKind; mtime: string }
export type EntryRevision = { path: string; kind: 'file' | 'directory'; revision: string }
export type TrashRecord = { id: string; path: string; kind: string; revision: string; deletedAt: string; state: string }
export type TrashPage = { entries: TrashRecord[]; total: number; offset: number; limit: number }
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
  entryRevision: (path: string) => request<EntryRevision>(`/entries/revision?path=${encodeURIComponent(path)}`),
  move: (from: string, to: string, revision: string) => request('/entries/move', { method: 'PATCH', headers: { 'If-Match': `"${revision}"` }, body: JSON.stringify({ from, to }) }),
  trash: (path: string, revision: string) => request<TrashRecord>(`/entries?path=${encodeURIComponent(path)}`, { method: 'DELETE', headers: { 'If-Match': `"${revision}"` } }),
  trashList: (offset = 0) => request<TrashPage>(`/trash?offset=${offset}`),
  restore: (id: string) => request<{ path: string }>(`/trash/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  metadata: (path: string) => request<FileMetadata>(`/files/metadata?path=${encodeURIComponent(path)}`),
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

export const fileURL = (path: string, preview = false) => `/api/v1/files/${preview ? 'preview' : 'download'}?path=${encodeURIComponent(path)}`
export function uploadFile(file: File, directory: string, onProgress?: (percent: number) => void, imageOnly = false, signal?: AbortSignal): Promise<FileMetadata> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/v1/uploads?directory=${encodeURIComponent(directory)}&image=${imageOnly}`)
    xhr.withCredentials = true; xhr.setRequestHeader('X-CSRF-Token', csrf); xhr.timeout = 120_000
    const abort = () => xhr.abort()
    if (signal?.aborted) { reject(new Error('上传已取消')); return }
    signal?.addEventListener('abort', abort, { once: true })
    const finish = () => signal?.removeEventListener('abort', abort)
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100)) }
    xhr.onerror = () => { finish(); reject(new Error('网络中断，上传结果待确认，请刷新目录后重试')) }
    xhr.ontimeout = () => { finish(); reject(new Error('上传超时，请确认目录中的文件后重试')) }
    xhr.onabort = () => { finish(); reject(new Error('上传已取消，请确认服务端是否已接收文件')) }
    xhr.onload = () => {
      finish()
      let body: FileMetadata & { error?: { code: string; message: string } }
      try { body = JSON.parse(xhr.responseText) } catch { reject(new Error(`上传响应无效（${xhr.status}），请确认文件是否已接收`)); return }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body)
      else {
        if (xhr.status === 401) window.dispatchEvent(new Event('folio:unauthenticated'))
        reject(new ApiError(xhr.status, body.error?.code ?? 'upload_failed', body.error?.message ?? '上传失败'))
      }
    }
    const form = new FormData(); form.append('file', file); xhr.send(form)
  })
}
