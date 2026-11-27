import { test, expect } from '@playwright/test'

test('切换和刷新恢复续写位置，版本变化时忽略旧位置，底栏按全文和选区计数', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const { csrfToken } = await (await page.request.get('/api/v1/auth/me')).json()
  const name = `续写-${Date.now()}.md`, other = `另一篇-${Date.now()}.txt`
  const content = `${'写作\n'.repeat(120)}你好 Folio！`
  const headers = { 'X-CSRF-Token': csrfToken }
  for (const [path, text] of [[name, content], [other, '另一篇']]) {
    expect((await page.request.post('/api/v1/files', { headers, data: { path, content: text } })).status()).toBe(201)
    await page.keyboard.press('Control+p')
    await page.getByRole('combobox').fill(path)
    await page.getByRole('option').filter({ hasText: path }).click()
    await expect(page.getByRole('tab', { name: path, exact: true })).toHaveAttribute('aria-selected', 'true')
  }
  const tab = (path: string) => page.getByRole('tab', { name: path, exact: true })
  const editor = page.getByRole('textbox', { name: 'Markdown 编辑器' })
  const count = page.locator('.file-word-count')
  const scrollTop = () => page.locator('.cm-scroller').evaluate(el => el.scrollTop)
  await expect(count).toHaveText('3 字')
  await tab(name).click()
  await expect(count).toHaveText('243 字')
  await editor.press('Control+End')
  await editor.press('Shift+Home')
  await expect(count).toHaveText('选中 3 字')
  const savedTop = await scrollTop()
  expect(savedTop).toBeGreaterThan(500)

  await tab(other).click()
  await expect(count).toHaveText('3 字')
  await tab(name).click()
  await expect(count).toHaveText('选中 3 字')
  // 实时预览重测行高时，像素坐标可以有不到一行的偏差。
  await expect.poll(async () => Math.abs(await scrollTop() - savedTop)).toBeLessThan(24)
  await page.reload()
  await expect(tab(name)).toHaveAttribute('aria-selected', 'true')
  await expect(count).toHaveText('选中 3 字')
  await expect.poll(async () => Math.abs(await scrollTop() - savedTop)).toBeLessThan(24)

  await tab(other).click()
  const url = `/api/v1/files/content?path=${encodeURIComponent(name)}`
  const { revision } = await (await page.request.get(url)).json()
  expect((await page.request.put(url, { headers: { ...headers, 'If-Match': `"${revision}"` }, data: { content: `新${content}`, encoding: 'utf-8' } })).ok()).toBe(true)
  await page.reload()
  await tab(name).click()
  await expect(count).toHaveText('244 字')
  await expect.poll(scrollTop).toBe(0)
  await editor.press('Control+End')
  await page.keyboard.insertText(' 中文 ABC')
  await expect(count).toHaveText('247 字')
})
