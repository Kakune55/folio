import { create } from 'zustand'

type Preferences = { width: 800 | 1200 | 1600; fontSize: 14 | 16 | 18 }
const defaults: Preferences = { width: 1200, fontSize: 16 }
const key = 'folio.appearance'
let initial = defaults
let storageError = ''
try {
  const raw = localStorage.getItem(key)
  if (raw) {
    const saved = JSON.parse(raw)
    if (![800, 1200, 1600].includes(saved?.width) || ![14, 16, 18].includes(saved?.fontSize)) throw new Error('无效偏好')
    initial = { width: saved.width, fontSize: saved.fontSize }
  }
} catch { storageError = '无法读取本机偏好，当前使用默认值。可重新选择或恢复默认后重试保存。' }

export const useAppearance = create<Preferences & {
  storageError: string
  update: (preferences: Partial<Preferences>) => void
  reset: () => void
}>((set, get) => ({
  ...initial, storageError,
  update: (preferences) => {
    const next = { width: get().width, fontSize: get().fontSize, ...preferences }
    let error = ''
    try { localStorage.setItem(key, JSON.stringify(next)) }
    catch { error = '设置已在当前页面生效，但无法保存到浏览器。请允许本机存储后重新选择或恢复默认以重试。' }
    set({ ...next, storageError: error })
  },
  reset: () => get().update(defaults),
}))
