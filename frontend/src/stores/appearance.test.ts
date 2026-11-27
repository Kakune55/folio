import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('个性化偏好：输入时滚动', () => {
  beforeEach(() => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, clear: () => data.clear() })
    vi.resetModules()
  })
  it('旧偏好缺少字段时默认开启舒适区', async () => {
    localStorage.setItem('folio.appearance', JSON.stringify({ width: 800, fontSize: 14 }))
    const { useAppearance } = await import('./appearance')
    expect(useAppearance.getState()).toMatchObject({ width: 800, fontSize: 14, comfortScroll: '3/4', storageError: '' })
  })
  it('切换后保存并保留其他偏好', async () => {
    const { useAppearance } = await import('./appearance')
    useAppearance.getState().update({ comfortScroll: '2/3' })
    expect(JSON.parse(localStorage.getItem('folio.appearance')!)).toEqual({ width: 1200, fontSize: 16, comfortScroll: '2/3' })
  })
  it('早期布尔值按 3/4 或关闭读取', async () => {
    localStorage.setItem('folio.appearance', JSON.stringify({ width: 800, fontSize: 14, comfortScroll: false }))
    const { useAppearance } = await import('./appearance')
    expect(useAppearance.getState().comfortScroll).toBe('off')
  })
  it('非法值回退默认并提示', async () => {
    localStorage.setItem('folio.appearance', JSON.stringify({ width: 800, fontSize: 14, comfortScroll: 'yes' }))
    const { useAppearance } = await import('./appearance')
    expect(useAppearance.getState().comfortScroll).toBe('3/4')
    expect(useAppearance.getState().storageError).not.toBe('')
  })
})
