import { create } from 'zustand'

export type Theme = 'system' | 'light' | 'dark'
let initialTheme: Theme = 'system'
try {
  const saved = localStorage.getItem('folio.theme')
  if (saved === 'light' || saved === 'dark') initialTheme = saved
} catch { /* 浏览器禁止持久化时仍可在当前页面切换主题。 */ }

export const useUI = create<{
  activePath: string
  sidebar: boolean
  theme: Theme
  open: (path: string) => void
  toggleSidebar: () => void
  setTheme: (theme: Theme) => void
}>((set) => ({
  activePath: '开始使用.md', sidebar: true, theme: initialTheme,
  open: (activePath) => set({ activePath }),
  toggleSidebar: () => set((state) => ({ sidebar: !state.sidebar })),
  setTheme: (theme) => {
    try { localStorage.setItem('folio.theme', theme) } catch { /* 仅影响偏好持久化，不影响正文。 */ }
    set({ theme })
  },
}))
