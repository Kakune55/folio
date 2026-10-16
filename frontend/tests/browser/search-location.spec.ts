import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
}
async function create(page: Page, name: string, content: string) {
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path: name, content } })).status()).toBe(201)
}
async function searchOpen(page: Page, query: string, name: string) {
  await page.keyboard.press('Control+p')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').fill(query)
  const option = dialog.getByRole('option').filter({ hasText: name })
  await expect(option).toBeVisible()
  await option.click()
  await expect(dialog).not.toBeVisible()
}

test('TXT 搜索定位远处关键词，重复搜索不重建编辑器并保留未保存正文', async ({ page }) => {
  await login(page)
  const id = Date.now(), keyword = `TARGET_${id}`
  const name = `定位-${id}.txt`
  const content = Array.from({ length: 650 }, (_, i) => i === 500 ? `中文命中 ${keyword} 终点` : i === 100 ? `SECOND_${id}` : `第 ${i} 行普通正文`).join('\r\n')
  await create(page, name, content)
  await searchOpen(page, keyword.toLowerCase(), name)
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await expect(source).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(keyword)
  await expect(source.locator('.cm-line').filter({ hasText: keyword })).toBeInViewport()
  await source.evaluate((element) => element.setAttribute('data-instance-probe', 'same'))
  await searchOpen(page, `SECOND_${id}`, name)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(`SECOND_${id}`)
  await expect(source).toHaveAttribute('data-instance-probe', 'same')
  await page.route('**/api/v1/files/content?**', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 503, json: { error: { code: 'test', message: '保留草稿验证' } } }) : route.continue())
  await source.press('Control+End')
  await page.keyboard.insertText('未保存的额外文字')
  await searchOpen(page, keyword, name)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(keyword)
  await expect(source).toHaveAttribute('data-instance-probe', 'same')
  const server = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()
  expect(server.content).toBe(content)
  await source.press('Control+End')
  await expect(source.locator('.cm-line').last()).toContainText('未保存的额外文字')
})

for (const width of [1440, 390]) test(`Markdown 富文本 ${width} 定位强调文字，未修改正文；纯文件名命中正常打开`, async ({ page }) => {
  await login(page)
  await page.setViewportSize({ width, height: 844 })
  const drawer = page.getByRole('button', { name: '关闭文件列表' })
  if (width < 768) { await expect(drawer).toBeVisible(); await drawer.click(); await expect(page.getByRole('dialog', { name: '文件列表' })).not.toBeVisible() }
  const id = Date.now(), keyword = `RICH_${id}`
  const name = `富文本定位-${id}.md`
  const original = '# 标题\n\n' + Array.from({ length: 90 }, (_, i) => i === 75 ? `前缀 **${keyword}** 后缀` : `第 ${i} 段普通正文。`).join('\n\n') + '\n'
  await create(page, name, original)
  await searchOpen(page, keyword, name)
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await expect(rich).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(keyword)
  await expect(rich.locator('strong').filter({ hasText: keyword })).toBeInViewport()
  await rich.evaluate((element) => element.setAttribute('data-instance-probe', 'same'))
  await searchOpen(page, keyword, name)
  await expect(rich).toHaveAttribute('data-instance-probe', 'same')
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(keyword)
  const saved = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()
  expect(saved.content).toBe(original)
  await searchOpen(page, name, name)
  await expect(rich).toHaveAttribute('data-instance-probe', 'same')
  await expect(page.getByText(/当前正文中未找到该关键词/)).toHaveCount(0)
})

test('索引旧结果在草稿中已消失时明确提示并保留草稿', async ({ page }) => {
  await login(page)
  const id = Date.now(), keyword = `STALE_${id}`
  const name = `旧结果-${id}.txt`
  await create(page, name, keyword)
  await searchOpen(page, keyword, name)
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await page.route('**/api/v1/files/content?**', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 503, json: { error: { code: 'test', message: '保留草稿验证' } } }) : route.continue())
  await source.press('Control+a'); await page.keyboard.insertText('完全不同的未保存正文')
  await searchOpen(page, keyword, name)
  await expect(page.getByText(/当前正文中未找到该关键词/)).toBeVisible()
  await expect(source).toContainText('完全不同的未保存正文')
})
