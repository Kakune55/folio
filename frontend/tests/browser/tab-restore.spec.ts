import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('刷新恢复标签顺序与当前文件，关闭同步、读取最新正文并保留失败记录', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const names = [`标签甲-${Date.now()}.txt`, `标签乙-${Date.now()}.md`, `标签丙-${Date.now()}.txt`]
  for (const path of names) expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path, content: '服务器原文\n' } })).status()).toBe(201)
  const open = async (path: string) => {
    await page.keyboard.press('Control+p')
    await page.getByRole('combobox').fill(path)
    await page.getByRole('option').filter({ hasText: path }).click()
    await expect(page.getByRole('tab', { name: path, exact: true })).toHaveAttribute('aria-selected', 'true')
  }
  for (const path of names) await open(path)
  await open(names[0])
  const contentURL = `/api/v1/files/content?path=${encodeURIComponent(names[0])}`
  const original = await (await page.request.get(contentURL)).json()
  expect((await page.request.put(contentURL, { headers: { 'X-CSRF-Token': principal.csrfToken, 'If-Match': `"${original.revision}"` }, data: { content: '服务器最新正文\n', encoding: 'utf-8' } })).ok()).toBe(true)
  await page.reload()
  await expect(page.getByRole('tab')).toHaveText(names)
  await expect(page.getByRole('tab', { name: names[0], exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('textbox', { name: '源码编辑器' })).toContainText('服务器最新正文')
  await page.getByRole('tab', { name: names[1], exact: true }).press('Delete')
  await expect(page.getByRole('tab')).toHaveText([names[0], names[2]])
  await page.reload()
  await expect(page.getByRole('tab')).toHaveText([names[0], names[2]])
  const key = `folio.tabs.v1:${principal.id}:${principal.workspaceId}`
  await page.evaluate(({ key, names }) => {
    localStorage.setItem(key, JSON.stringify({ version: 1, paths: names, activePath: names[2] }))
    localStorage.setItem('folio.tabs.v1:999:other-workspace', JSON.stringify({ version: 1, paths: ['不应打开.txt'], activePath: '不应打开.txt' }))
  }, { key, names })
  let writes = 0
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/files/content')) writes++ })
  await page.route('**/api/v1/files/metadata?**', async route => {
    if (new URL(route.request().url()).searchParams.get('path') === names[1]) await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '文件不存在' } } })
    else await route.continue()
  })
  await page.reload()
  await expect(page.getByText(/部分标签未恢复/)).toBeVisible()
  await expect(page.getByRole('tab')).toHaveText([names[0], names[2]])
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).paths, key)).toContain(names[1])
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const closeDrawer = page.getByRole('button', { name: '关闭文件列表' })
    if (width < 768) {
      await expect(closeDrawer).toBeVisible()
      await closeDrawer.click()
      await expect(page.getByRole('dialog', { name: '文件列表', exact: true })).not.toBeVisible()
    }
    await expect(page.getByText(/部分标签未恢复/)).toBeVisible()
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
  await page.screenshot({ path: '../artifacts/tab-restore-mobile.png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.unroute('**/api/v1/files/metadata?**')
  await page.getByRole('button', { name: '重试标签记录' }).click()
  await expect(page.getByRole('tab', { name: names[1], exact: true })).toBeVisible()
  expect(writes).toBe(0)
  // 损坏及不可用存储必须明确显示并可以恢复，不能隐藏失败。
  await page.evaluate(key => localStorage.setItem(key, '{broken'), key)
  await page.reload()
  await expect(page.getByText(/无法读取本机标签记录/)).toBeVisible()
  await page.getByRole('button', { name: '仅记住当前标签' }).click()
  await expect(page.getByText(/无法读取本机标签记录/)).toHaveCount(0)
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError') } })
  await open(names[0])
  await expect(page.getByText(/无法保存本机标签记录/)).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
})

test('异步恢复不抢走用户选择，也不替换已编辑会话', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const names = [`先恢复-${Date.now()}.txt`, `后恢复-${Date.now()}.txt`]
  for (const path of names) expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path, content: '原文' } })).status()).toBe(201)
  await page.evaluate(({ principal, names }) => localStorage.setItem(`folio.tabs.v1:${principal.id}:${principal.workspaceId}`, JSON.stringify({ version: 1, paths: names, activePath: names[1] })), { principal, names })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/v1/files/metadata?**', async route => {
    if (new URL(route.request().url()).searchParams.get('path') === names[1]) await gate
    await route.continue()
  })
  await page.reload()
  await page.getByRole('tab', { name: names[0], exact: true }).click()
  const editor = page.getByRole('textbox', { name: '源码编辑器' })
  await editor.fill('恢复期间继续编辑')
  release()
  await expect(page.getByRole('tab')).toHaveText(names)
  await expect(page.getByRole('tab', { name: names[0], exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(editor).toContainText('恢复期间继续编辑')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  expect((await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(names[0])}`)).json()).content).toBe('恢复期间继续编辑')
})

test('失败路径手动打开后再关闭，不会重新进入待恢复记录', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const path = `稍后创建-${Date.now()}.txt`, key = `folio.tabs.v1:${principal.id}:${principal.workspaceId}`
  await page.evaluate(({ key, path }) => localStorage.setItem(key, JSON.stringify({ version: 1, paths: [path], activePath: path })), { key, path })
  await page.reload()
  await expect(page.getByText(/部分标签未恢复/)).toBeVisible()
  expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path, content: '新正文' } })).status()).toBe(201)
  await page.keyboard.press('Control+p')
  await page.getByRole('combobox').fill(path)
  await page.getByRole('option').filter({ hasText: path }).click()
  await page.getByRole('tab', { name: path, exact: true }).press('Delete')
  await expect(page.getByRole('tab')).toHaveCount(0)
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).paths, key)).toEqual([])
})
