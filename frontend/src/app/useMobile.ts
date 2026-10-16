import { useEffect, useSyncExternalStore } from 'react'

const query = window.matchMedia('(max-width: 767px)')
const subscribe = (listener: () => void) => { query.addEventListener('change', listener); return () => query.removeEventListener('change', listener) }
export function useMobile() {
  const mobile = useSyncExternalStore(subscribe, () => query.matches)
  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => {
      // 缩放时保留浏览器自身的放大和平移，不强行改变文档布局。
      if (!mobile || !viewport || viewport.scale !== 1) {
        document.documentElement.style.removeProperty('--folio-visible-height'); document.documentElement.style.removeProperty('--folio-visible-top'); return
      }
      document.documentElement.style.setProperty('--folio-visible-height', `${viewport.height}px`)
      document.documentElement.style.setProperty('--folio-visible-top', `${viewport.offsetTop}px`)
    }
    update(); viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update)
    return () => { viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); document.documentElement.style.removeProperty('--folio-visible-height'); document.documentElement.style.removeProperty('--folio-visible-top') }
  }, [mobile])
  return mobile
}
