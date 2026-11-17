import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const id = 'abcdefghijklmnop'
const importURL = `**/api/v1/shares/${id}/import`
async function prepare(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect((await page.request.post('/api/v1/auth/login', { data: { username: 'admin', password: 'folio-browser-test-password-2026' } })).ok()).toBe(true)
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const file = { id: 'main', path: '来源/主文档.txt', revision: 'v1', size: 12, viewer: 'text' }
  await page.route(`**/api/v1/public/shares/${id}**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    const json = path.endsWith('/manifest') ? { id, root: file.path, title: '转存测试', mode: 'live', files: [file], version: 'v1' } : path.endsWith('/metadata') ? { path: file.path, size: 12, viewer: 'text', mtime: '1', mediaType: 'text/plain' } : path.endsWith('/content') ? { content: '分享原文', html: '' } : { protected: false }
    await route.fulfill({ json })
  })
  await page.goto(`/s/${id}`)
  await expect(page.getByRole('button', { name: '保存到我的工作区', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '保存到我的工作区', exact: true }).click()
  return { principal, dialog: page.getByRole('dialog', { name: '保存到我的工作区', exact: true }) }
}

test('转存复用目录浏览：读取失败可重试、未就绪不可提交，手机明暗布局与取消不写入', async ({ page }) => {
  let attempt = 0, imports = 0
  const scopes: (string | undefined)[] = []
  let release: (() => void) | undefined
  await page.route('**/api/v1/workspace/tree?*', async (route) => {
    scopes.push(route.request().headers()['x-folio-workspace'])
    if (++attempt === 1) { await route.fulfill({ status: 503, json: { error: { message: '目录读取失败' } } }); return }
    const path = new URL(route.request().url()).searchParams.get('path') ?? ''
    if (path) await new Promise<void>((resolve) => { release = resolve })
    await route.fulfill({ json: { entries: path ? [] : [{ name: '目标', path: '目标', kind: 'directory', size: 0 }], total: path ? 0 : 1, offset: 0, limit: 100 } })
  })
  await page.route(importURL, (route) => { imports++; return route.fulfill({ json: { path: '不会提交' } }) })
  const { principal, dialog } = await prepare(page)
  await expect(dialog.getByRole('alert')).toContainText('目录读取失败')
  await expect(dialog.getByRole('button', { name: '确认转存' })).toBeDisabled()
  await dialog.getByRole('button', { name: '重试', exact: true }).click()
  await dialog.getByRole('button', { name: '进入目录 目标', exact: true }).click()
  await expect(dialog.getByText('正在读取目标目录…')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '确认转存' })).toBeDisabled()
  release!()
  await expect(dialog.getByRole('button', { name: '确认转存' })).toBeEnabled()
  await dialog.getByLabel('副本文件夹名称').fill('../越界')
  await expect(dialog.getByRole('button', { name: '确认转存' })).toBeDisabled()
  await dialog.getByLabel('副本文件夹名称').press('Enter')
  expect(imports).toBe(0)
  await dialog.getByLabel('副本文件夹名称').fill('我的副本')
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
      expect((await new AxeBuilder({ page }).include('.share-import-dialog').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([])
      const box = (await dialog.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      await expect(dialog.getByRole('button', { name: '确认转存' })).toBeInViewport()
    }
  }
  expect(scopes.every((scope) => scope === principal.workspaceId)).toBe(true)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(imports).toBe(0)
})

for (const failure of ['network', 'server', 'json'] as const) test(`转存结果未知保留目标并阻止直接重试：${failure}`, async ({ page }) => {
  let imports = 0
  await page.route('**/api/v1/workspace/tree?*', (route) => route.fulfill({ json: { entries: [], total: 0, offset: 0, limit: 100 } }))
  await page.route(importURL, (route) => {
    imports++
    if (failure === 'network') return route.abort()
    if (failure === 'json') return route.fulfill({ status: 201, contentType: 'application/json', body: '{' })
    return route.fulfill({ status: 503, json: { error: { message: '服务暂不可用' } } })
  })
  const { dialog } = await prepare(page)
  await dialog.getByLabel('副本文件夹名称').fill('待核对副本')
  await expect(dialog.getByRole('button', { name: '确认转存' })).toBeEnabled()
  await dialog.getByRole('button', { name: '确认转存' }).click()
  await expect(dialog.getByRole('alert')).toContainText('转存结果尚未确认')
  await expect(dialog.getByRole('alert')).toContainText('待核对副本')
  await expect(dialog.getByRole('button', { name: '确认转存' })).toBeDisabled()
  await expect(dialog.getByLabel('副本文件夹名称')).toBeDisabled()
  await dialog.locator('form').evaluate((form) => (form as HTMLFormElement).requestSubmit())
  expect(imports).toBe(1)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).not.toBeVisible()
})

test('转存进行中固定名称与目标目录，防止重复提交并保留账号绑定', async ({ page }) => {
  let release: (() => void) | undefined
  const requests: { directory: string; file: string; scope?: string; csrf?: string }[] = []
  await page.route('**/api/v1/workspace/tree?*', (route) => route.fulfill({ json: { entries: [], total: 0, offset: 0, limit: 100 } }))
  await page.route(importURL, async (route) => {
    requests.push({ ...route.request().postDataJSON(), scope: route.request().headers()['x-folio-workspace'], csrf: route.request().headers()['x-csrf-token'] })
    await new Promise<void>((resolve) => { release = resolve })
    await route.fulfill({ status: 201, json: { path: '独立副本' } })
  })
  const { principal, dialog } = await prepare(page)
  await dialog.getByLabel('副本文件夹名称').fill('独立副本')
  await expect(dialog.getByRole('button', { name: '确认转存' })).toBeEnabled()
  await dialog.getByRole('button', { name: '确认转存' }).click()
  await expect(dialog.getByLabel('副本文件夹名称')).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '工作区根目录' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await dialog.locator('form').evaluate((form) => (form as HTMLFormElement).requestSubmit())
  expect(requests).toEqual([{ directory: '独立副本', file: 'main', scope: principal.workspaceId, csrf: principal.csrfToken }])
  release!()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByText('已保存到我的工作区：独立副本。这是独立副本。', { exact: true })).toBeVisible()
})
