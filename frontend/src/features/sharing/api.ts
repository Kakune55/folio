import { request } from '../../services/api'
import type { FileMetadata, ViewerKind } from '../../services/api'
export type Selection = { path: string; revision: string; metadata?: FileMetadata }
export type ShareFile = { id: string; path: string; revision: string; size: number; viewer: ViewerKind }
export type Share = { id: string; root: string; title: string; mode: 'snapshot' | 'live'; files: ShareFile[]; expiresAt: number; maxVisits: number; visits: number; disabled: boolean; protected: boolean; createdAt: number; version: string }
export type ShareInput = { root: string; title: string; mode: 'snapshot' | 'live'; files?: Selection[]; expiresAt: number; maxVisits: number; password?: string; disabled: boolean; version?: string }
// 公开分享请求独立于工作区身份和认证事件；匿名查看不会让已打开工作区退出登录。
export async function publicRequest<T>(url: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/public/shares/${url}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal }).catch(() => { throw new Error('网络请求未完成，请检查连接后重试；重新打开分享可核对既有访问资格。') })
  if (!response.ok) { const value = await response.json().catch(() => null); throw new Error(value?.error?.message ?? `请求失败（${response.status}）`) }
  return response.json().catch(() => { throw new Error('服务器响应无法读取，请检查服务状态后重试。') })
}
async function sharingRequest<T>(url: string, init?: RequestInit): Promise<T> {
 try { return await request<T>(url, init) }
 catch (error) { if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('网络请求未完成，请检查连接；创建或更新分享前请先核对管理列表，再重试。'); throw error }
}
export const shares = {
 list: (offset = 0) => sharingRequest<{ entries: Share[]; total: number }>(`/shares?offset=${offset}&limit=20`),
 analyze: (root: string, include: boolean) => sharingRequest<{ files: Selection[]; warnings: string[] }>('/shares/analyze', { method: 'POST', body: JSON.stringify({ root, include }) }),
 save: (value: ShareInput, id?: string) => sharingRequest<Share>(id ? `/shares/${id}` : '/shares', { method: id ? 'PUT' : 'POST', body: JSON.stringify(value) }),
 remove: (id: string) => sharingRequest(`/shares/${id}`, { method: 'DELETE' }),
 import: (id: string, file: string, directory: string) => sharingRequest<{ path: string }>(`/shares/${id}/import`, { method: 'POST', body: JSON.stringify({ file, directory }) }),
}
export const shareFileURL = (id: string, file: string, action: 'download' | 'preview') => `/api/v1/public/shares/${id}/files/${file}/${action}`
