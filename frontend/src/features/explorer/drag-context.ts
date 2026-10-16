import { createContext, useContext } from 'react'
import type { DragEvent } from 'react'
import type { Entry } from '../../services/api'

export type DragControls = {
  entry?: Entry; target: string | null; busy: boolean
  start: (event: DragEvent<HTMLElement>, entry: Entry) => void
  end: () => void
  over: (event: DragEvent<HTMLElement>, directory: string) => void
  leave: (event: DragEvent<HTMLElement>) => void
  drop: (event: DragEvent<HTMLElement>, directory: string) => boolean
}
export const DragContext = createContext<DragControls | null>(null)
export function useEntryDrag() { const value = useContext(DragContext); if (!value) throw new Error('文件拖拽上下文不存在'); return value }

