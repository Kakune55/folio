import { describe, expect, it } from 'vitest'
import { createNotificationStore } from './notifications'

describe('公共通知状态', () => {
  it('同文案去重，按 ID 更新任务，不重复追加', () => {
    const store = createNotificationStore()
    const id = store.loading('正在上传', { progress: 0 })
    store.update(id, { progress: 42 })
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0].progress).toBe(42)
    store.success('上传完成', { id })
    store.success('上传完成')
    expect(store.snapshot()).toHaveLength(1)
    expect(store.snapshot()[0]).toMatchObject({ id, kind: 'success', remaining: 4000 })
    expect(store.snapshot()[0].progress).toBeUndefined()
  })

  it('只对显示的三条计时，暂停和排队均不消耗时间', () => {
    const store = createNotificationStore()
    const ids = Array.from({ length: 4 }, (_, i) => store.success(`通知 ${i}`))
    store.advance(3000, new Set([ids[0]]))
    expect(store.snapshot().map((entry) => entry.remaining)).toEqual([4000, 1000, 1000, 4000])
    store.advance(1000, new Set([ids[0]]))
    expect(store.snapshot().map((entry) => entry.id)).toEqual([ids[0], ids[3]])
    store.advance(4000, new Set())
    expect(store.snapshot()).toEqual([])
  })

  it('同名并发任务保持独立，只按显式 ID 合并', () => {
    const store = createNotificationStore()
    const first = store.loading('正在上传')
    const second = store.loading('正在上传')
    expect(first).not.toBe(second)
    store.success('上传完成', { id: first })
    store.update(second, { progress: 50 })
    expect(store.snapshot().map((entry) => entry.kind)).toEqual(['success', 'loading'])
    expect(store.snapshot()[1].progress).toBe(50)
  })

  it('错误、操作按钮和任务不自动消失，进度更新不复活已关闭卡片', () => {
    const store = createNotificationStore()
    store.error('失败', { duration: 100 })
    store.info('需要处理', { action: { label: '重试', onClick: () => {} } })
    const id = store.loading('进行中')
    store.advance(60_000, new Set())
    expect(store.snapshot()).toHaveLength(3)
    store.dismiss(id); store.update(id, { progress: 80 })
    expect(store.snapshot()).toHaveLength(2)
  })

  it('队列可以切换查看，清空后旧任务结果不跨身份重新显示', () => {
    const store = createNotificationStore()
    const id = store.loading('旧工作区任务')
    store.info('二'); store.info('三'); store.error('四')
    store.next()
    expect(store.snapshot()[0].message).toBe('四')
    store.clear()
    store.success('迟到的结果', { id })
    expect(store.snapshot()).toEqual([])
    store.success('新工作区')
    expect(store.snapshot()).toHaveLength(1)
  })
})
