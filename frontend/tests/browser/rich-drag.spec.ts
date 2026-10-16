import { test, expect } from '@playwright/test'

for (const blank of [false, true]) test(`富文本无整圈焦点框，手柄拖到${blank ? '末尾空白区' : '段落下沿'}移动、保存和撤销`, async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const name = `段落拖拽-${Date.now()}.md`
  const original = '# 标题\n\n第一段\n\n第二段\n\n第三段\n'
  expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path: name, content: original } })).status()).toBe(201)
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name, exact: true }).click()
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await expect(rich).toBeVisible()
  await rich.focus()
  expect(await rich.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none')
  await rich.locator('p').filter({ hasText: '第二段' }).hover()
  const handle = page.locator('.milkdown-block-handle .operation-item').last()
  await expect(handle).toBeVisible()
  const from = await handle.boundingBox()
  const target = await rich.locator('p').filter({ hasText: '第三段' }).boundingBox()
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(from!.x + from!.width / 2 + 8, from!.y + from!.height / 2 + 8, { steps: 5 })
  await page.mouse.move(target!.x + 30, target!.y + target!.height + (blank ? 80 : -1), { steps: 15 })
  await page.mouse.up()
  await expect(rich.locator('p')).toHaveText(['第一段', '第三段', '第二段'])
  const moved = '# 标题\n\n第一段\n\n第三段\n\n第二段\n'
  await expect.poll(async () => (await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()).content).toBe(moved)
  await rich.focus(); await page.keyboard.press('Control+z')
  await expect(rich.locator('p')).toHaveText(['第一段', '第二段', '第三段'])
  await expect.poll(async () => (await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()).content).toBe(original)
})
