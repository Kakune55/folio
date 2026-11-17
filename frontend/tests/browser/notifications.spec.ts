import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
}

// 直接调用公共入口，验证复用能力；本文件使用 Vite 测试服务，不代表生产包验收。
async function show(page: Page, kind: 'success' | 'error' | 'loading' | 'info', message: string, options: { id?: string; progress?: number } = {}) {
  return page.evaluate(async ({ kind, message, options }) => {
    const path = '/src/stores/notifications.ts'
    const { notify } = await import(/* @vite-ignore */ path)
    return notify[kind](message, options) as string
  }, { kind, message, options })
}

test('通知不抢焦点，倒计时支持悬停、焦点和后台暂停', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.clock.install()
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000)
  await page.getByRole('button', { name: '打开回收站' }).focus()
  await show(page, 'success', '操作已完成')
  const card = page.getByRole('article', { name: '操作通知' })
  await expect(card).toBeVisible()
  await expect(page.getByRole('button', { name: '打开回收站' })).toBeFocused()
  await page.clock.runFor(1000)
  const remaining = () => card.locator('.notification-countdown > span').evaluate((element) => parseFloat((element as HTMLElement).style.width))
  await expect.poll(remaining).toBeLessThan(100)
  await card.hover()
  const beforeHover = await remaining()
  await page.clock.runFor(5000)
  expect(await remaining()).toBe(beforeHover)
  await card.getByRole('button', { name: '关闭通知' }).focus()
  await page.mouse.move(1, 1)
  await page.clock.runFor(5000)
  expect(await remaining()).toBe(beforeHover)
  await page.getByRole('button', { name: '打开回收站' }).focus()
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
  await page.clock.runFor(5000)
  expect(await remaining()).toBe(beforeHover)
  await page.evaluate(() => { Reflect.deleteProperty(document, 'hidden'); document.dispatchEvent(new Event('visibilitychange')) })
  await page.clock.runFor(4100)
  await expect(card).toHaveCount(0)
})

test('错误常驻、任务按 ID 更新、排队切换与操作失败可恢复', async ({ page }) => {
  await login(page)
  await page.clock.install()
  await show(page, 'error', '服务暂不可用')
  await show(page, 'loading', '正在上传', { id: 'upload-test', progress: 10 })
  await page.evaluate(async () => {
    const path = '/src/stores/notifications.ts'
    const { notify } = await import(/* @vite-ignore */ path)
    notify.update('upload-test', { progress: 64 })
    notify.info('有操作按钮', { action: { label: '重试任务', onClick: async () => { throw new Error('重试仍失败') } } })
    notify.info('排队通知')
  })
  const cards = page.getByRole('article', { name: '操作通知' })
  await expect(cards).toHaveCount(3)
  await expect(page.getByRole('progressbar', { name: '任务进度' })).toHaveAttribute('aria-valuenow', '64')
  await page.clock.runFor(10_000)
  await expect(cards).toHaveCount(3)
  await page.getByRole('button', { name: '重试任务' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '重试仍失败' })).toBeVisible()
  await page.getByRole('button', { name: '还有 1 条通知，点击查看' }).click()
  await expect(page.getByRole('status').filter({ hasText: '排队通知' })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('folio:workspace-changed')))
  await expect(cards).toHaveCount(0)
})

test('模态内通知位于视口右下角，可键盘关闭且不关闭回收站', async ({ page }) => {
  await login(page)
  await page.route('**/api/v1/trash?*', (route) => route.fulfill({ json: { entries: [{ id: 'one', path: '示例.md', kind: 'file', revision: 'v1', deletedAt: '2026-11-17T00:00:00Z', state: 'ready' }], total: 1, offset: 0, limit: 50 } }))
  await page.getByRole('button', { name: '打开回收站' }).click()
  const trash = page.getByRole('dialog', { name: '回收站', exact: true })
  await show(page, 'success', '已恢复 2 项。')
  const region = trash.getByRole('region', { name: '通知', exact: true })
  await expect(region.getByText('已恢复 2 项。')).toBeVisible()
  const box = (await region.boundingBox())!, viewport = page.viewportSize()!
  expect(viewport.width - box.x - box.width).toBeLessThanOrEqual(20)
  expect(viewport.height - box.y - box.height).toBeGreaterThanOrEqual(50)
  await region.getByRole('button', { name: '关闭通知' }).focus()
  await expect(region.getByRole('button', { name: '关闭通知' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trash).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(region.getByText('已恢复 2 项。')).toHaveCount(0)
  await expect(trash).toBeVisible()
  await trash.getByRole('button', { name: '永久删除', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '永久删除', exact: true })
  await show(page, 'info', '请核对删除清单')
  await expect(confirmation.getByRole('region', { name: '通知', exact: true }).getByText('请核对删除清单')).toBeVisible()
  await confirmation.getByRole('button', { name: '关闭通知' }).focus()
  await page.keyboard.press('Enter')
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(trash.getByRole('region', { name: '通知', exact: true })).toHaveCount(1)
  await trash.getByRole('button', { name: '关闭回收站' }).click()
  await show(page, 'info', '返回工作区后仍可通知')
  await expect(page.getByRole('region', { name: '通知', exact: true }).getByText('返回工作区后仍可通知')).toBeVisible()
})

test('进度条启用平滑插值，减少动态效果时禁用过渡', async ({ page }) => {
  await login(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await show(page, 'loading', '上传进度', { progress: 20 })
  await show(page, 'success', '完成提示')
  const progress = page.getByRole('progressbar', { name: '任务进度' }).locator('span')
  const countdown = page.locator('.notification-countdown > span')
  const transition = (element: Element) => {
    const style = getComputedStyle(element)
    return { property: style.transitionProperty, duration: style.transitionDuration, easing: style.transitionTimingFunction }
  }
  await expect(progress).toBeVisible()
  expect(await progress.evaluate(transition)).toEqual({ property: 'width', duration: '0.18s', easing: 'ease-out' })
  expect(await countdown.evaluate(transition)).toEqual({ property: 'width', duration: '0.1s', easing: 'linear' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect((await progress.evaluate(transition)).duration).toBe('0s')
  expect((await countdown.evaluate(transition)).duration).toBe('0s')
})

test('手机与明暗主题下长通知不撑宽页面', async ({ page }) => {
  await login(page)
  await page.setViewportSize({ width: 390, height: 740 })
  await page.getByRole('button', { name: '关闭文件列表' }).click()
  await show(page, 'error', `操作失败：${'很长的文件路径/'.repeat(15)}`)
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
    const region = page.getByRole('region', { name: '通知', exact: true })
    await expect(region.getByRole('button', { name: '关闭通知' })).toBeVisible()
    const box = (await region.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    expect(box.y + box.height).toBeLessThanOrEqual(740 - 50)
    await page.screenshot({ path: `test-results/notifications-mobile-${theme}.png` })
  }
})
