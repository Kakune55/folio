import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))

test('超限上传前提示类型上限与剩余配额，代理 413 保留具体原因', async ({ page }) => {
  await login(page)
  let count = 0
  await page.route('**/api/v1/settings', (route) => route.fulfill({ json: { limits: { image: 4, pdf: 8, attachment: 16 } } }))
  let remaining = 100
  await page.route('**/api/v1/workspace/usage', (route) => route.fulfill({ json: { used: 0, quota: remaining } }))
  await page.route('**/api/v1/uploads?**', (route) => { count++; return route.fulfill({ status: 413, contentType: 'text/html', body: '<h1>Too large</h1>' }) })
  const input = page.getByLabel('上传附件文件', { exact: true })
  for (const [name, size, message] of [['large.bin', 17, '附件上传上限 16 B'], ['large.png', 5, '图片上传上限 4 B'], ['large.pdf', 9, 'PDF上传上限 8 B']] as const) {
    await input.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(size) })
    await expect(page.locator('.upload-failure').filter({ hasText: name })).toContainText(message)
  }
  expect(count).toBe(0)
  remaining = 1
  await input.setInputFiles({ name: 'quota.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2) })
  await expect(page.locator('.upload-failure').filter({ hasText: 'quota.bin' })).toContainText('工作区仅剩 1 B')
  expect(count).toBe(0)
  remaining = 100
  await input.setInputFiles({ name: 'proxy.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2) })
  await expect(page.locator('.upload-failure').filter({ hasText: 'proxy.bin' })).toContainText('服务器或代理拒绝了上传')
  expect(count).toBe(1)
  await expect(page.getByRole('button', { name: '下载待上传原件 proxy.bin' })).toBeVisible()
})
async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
}

test('上传图片、PDF 和未知附件，类型安全预览与原始下载', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await login(page)
  const prefix = `附件-${Date.now()}`
  const png = await readFile(fixture('preview.png'))
  const pdf = await readFile(fixture('preview.pdf'))
  for (const file of [{ name: `${prefix}.png`, mimeType: 'image/png', buffer: png }, { name: `${prefix}.pdf`, mimeType: 'application/pdf', buffer: pdf }, { name: `${prefix}.zip`, mimeType: 'application/zip', buffer: Buffer.from([0x50, 0x4b, 0, 0, 1]) }]) {
    await page.getByLabel('上传附件文件').setInputFiles(file)
    await expect(page.getByRole('button', { name: file.name, exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: `${prefix}.png`, exact: true }).click()
  const image = page.getByRole('img', { name: `${prefix}.png` })
  await expect(image).toBeVisible()
  expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(320)
  await page.getByRole('button', { name: `${prefix}.pdf`, exact: true }).click()
  await expect(page.getByText('1 / 1', { exact: true })).toBeVisible()
  await expect(page.getByText('正在渲染 PDF…')).not.toBeVisible()
  await expect(page.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible()
  expect(await page.locator('canvas').evaluate((canvas) => [...canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data].some((value, index) => index % 4 !== 3 && value < 200))).toBe(true)
  await page.screenshot({ path: 'test-results/pdf-preview.png' })
  await page.getByRole('button', { name: `${prefix}.zip`, exact: true }).click()
  await expect(page.getByRole('heading', { name: '此类型提供下载' })).toBeVisible()
  const pending = page.waitForEvent('download')
  await page.getByRole('link', { name: '下载文件', exact: true }).first().click()
  expect(await readFile((await (await pending).path())!)).toEqual(Buffer.from([0x50, 0x4b, 0, 0, 1]))
  expect(errors).toEqual([])
})

test('图片粘贴完成后使用标准相对路径，切换文件不丢链接', async ({ page }) => {
  await login(page)
  const name = `图片笔记-${Date.now()}.md`
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await rich.fill('粘贴图片测试')
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const other = `图片切换-${Date.now()}.json`
  expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path: other, content: '{}' } })).status()).toBe(201)
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await expect(page.getByRole('button', { name: other, exact: true })).toBeVisible()
  await page.route('**/api/v1/uploads?**', async (route) => { await new Promise((resolve) => setTimeout(resolve, 600)); await route.continue() })
  const png = await readFile(fixture('preview.png'))
  await rich.evaluate((element, data) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(data)], '中文截图.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, [...png])
  await expect(page.locator('.save-status')).toHaveText('正在上传图片…')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await page.getByRole('button', { name: other, exact: true }).click()
  await expect(page.getByRole('textbox', { name: '源码编辑器' })).toHaveText('{}')
  await page.getByRole('tab', { name, exact: true }).click()
  await expect(page.getByRole('textbox', { name: '源码编辑器' })).toContainText('![中文截图.png](./image-')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  const content = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()
  expect(content.content).not.toContain('/api/')
  expect(content.content).toContain('![中文截图.png](./image-')
  await page.getByRole('button', { name: '富文本', exact: true }).click()
  await expect(page.locator('.folio-markdown-image')).toBeVisible()
  await expect.poll(async () => page.locator('.folio-markdown-image').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(320)
  await page.unroute('**/api/v1/uploads?**')
  await rich.click()
  await page.keyboard.press('Control+End')
  await rich.evaluate((element, data) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], '第二张.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, [...png])
  await expect(page.locator('.folio-markdown-image')).toHaveCount(2)
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await source.click(); await page.keyboard.press('Control+End')
  await source.evaluate((element, data) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], '源码图片.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, [...png])
  await expect(source).toContainText('![源码图片.png](./image-')
  await expect(page.locator('.save-status')).toHaveText('已保存')
})
