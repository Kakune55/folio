import { useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import type { Entry } from '../../services/api'
import { DragContext } from './drag-context'
import type { DragControls } from './drag-context'
import { workspace } from '../../sessions/current'

import { beginEntryTransfer, endEntryTransfer, entryMime as mime } from './entry-transfer'

export function EntryDragProvider({ children, disabled, onMove, onNotice, onDirectory }: {
  children: ReactNode; disabled: boolean; onMove: (entry: Entry, directory: string) => Promise<void>
  onNotice: (message: string) => void; onDirectory: (path: string) => void
}) {
  // 只信任本页面开始的拖拽，不从外部 DataTransfer 解析路径或执行文件操作。
  const source = useRef<Entry | undefined>(undefined)
  const pending = useRef(false)
  const gesture = useRef('')
  const [entry, setEntry] = useState<Entry>()
  const [target, setTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const end = () => { source.current = undefined; gesture.current = ''; endEntryTransfer(); setEntry(undefined); setTarget(null) }
  useEffect(() => {
    const clear = () => { source.current = undefined; gesture.current = ''; endEntryTransfer(); setEntry(undefined); setTarget(null) }
    document.addEventListener('dragend', clear); document.addEventListener('drop', clear)
    return () => { document.removeEventListener('dragend', clear); document.removeEventListener('drop', clear); endEntryTransfer() }
  }, [])
  const internal = (event: DragEvent<HTMLElement>) => !!source.current && event.dataTransfer.types.includes(mime) && !event.dataTransfer.types.includes('Files')
  const allowed = (directory: string) => {
    const from = source.current
    return !!from && !disabled && !pending.current && directory !== from.path && !directory.startsWith(`${from.path}/`) && from.path.split('/').slice(0, -1).join('/') !== directory
  }
  const controls: DragControls = {
    entry, target, busy, end,
    start: (event, value) => {
      if (disabled || pending.current || workspace.isLocked(value.path)) { event.preventDefault(); return }
      source.current = value; setEntry(value); setTarget(null)
      gesture.current = beginEntryTransfer(value, event.dataTransfer)
    },
    over: (event, directory) => {
      if (!internal(event)) return
      event.preventDefault(); event.stopPropagation()
      const valid = allowed(directory)
      event.dataTransfer.dropEffect = valid ? 'move' : 'none'; setTarget(valid ? directory : null)
    },
    leave: (event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setTarget(null) },
    drop: (event, directory) => {
      if (!internal(event)) return false
      event.preventDefault(); event.stopPropagation()
      const from = source.current, valid = allowed(directory) && event.dataTransfer.getData(mime) === gesture.current
      end()
      if (!from || !valid) return false
      pending.current = true; setBusy(true)
      void onMove(from, directory).then(() => onDirectory(directory)).catch((error) => onNotice(error instanceof Error ? error.message : '移动失败，原文件和草稿仍保留，请刷新确认')).finally(() => { pending.current = false; setBusy(false) })
      return true
    },
  }
  return <DragContext.Provider value={controls}>{children}<div className="tree-drag-status" role="status">{busy ? '正在移动文件…' : entry ? target !== null ? `移动到：${target || '工作区根目录'}` : '拖到文件夹以移动，拖到 Markdown 正文以插入引用' : ''}</div></DragContext.Provider>
}
