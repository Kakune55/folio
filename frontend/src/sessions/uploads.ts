export type PendingUpload = { id: string; file: File; directory: string; imageOnly: boolean; onUploaded?: (path: string) => void; state: 'sending' | 'failed'; error: string }
// 原件保留到服务端明确确认成功；登录过期也不销毁尚待处理的拍照/附件文件。
class UploadQueue {
  private entries: PendingUpload[] = []
  private listeners = new Set<() => void>()
  snapshot = () => this.entries
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit() { this.listeners.forEach((listener) => listener()) }
  add(file: File, directory: string, imageOnly = false) { const entry: PendingUpload = { id: crypto.randomUUID(), file, directory, imageOnly, state: 'sending', error: '' }; this.entries = [...this.entries, entry]; this.emit(); return entry }
  retry(id: string, directory: string) { this.entries = this.entries.map((entry) => entry.id === id ? { ...entry, directory, state: 'sending', error: '' } : entry); this.emit() }
  fail(id: string, error: string) { this.entries = this.entries.map((entry) => entry.id === id ? { ...entry, state: 'failed', error } : entry); this.emit() }
  remove(id: string) { this.entries = this.entries.filter((entry) => entry.id !== id); this.emit() }
}
export const uploadQueue = new UploadQueue()
export function downloadUpload(file: File) {
  const url = URL.createObjectURL(file), link = document.createElement('a')
  link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
