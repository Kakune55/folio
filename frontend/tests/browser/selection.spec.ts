import { test, expect } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}：源码拖选清晰，当前行不遮挡选区，编辑器不画整圈焦点框`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/')
    await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
    await page.getByRole('button', { name: '进入工作区' }).click()
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
    const principal = await (await page.request.get('/api/v1/auth/me')).json()
    const name = `选区-${theme}-${Date.now()}.txt`
    const content = '第一行用于验证拖选文字\n第二行被完整选中\n第三行验证选择终点\n第四行保留原文\n'
    expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path: name, content } })).status()).toBe(201)
    await page.getByRole('button', { name: '刷新文件列表' }).click()
    await page.getByRole('button', { name, exact: true }).click()
    const source = page.getByRole('textbox', { name: '源码编辑器' })
    await expect(source).toBeVisible()
    const point = async (line: number, offset: number) => source.locator('.cm-line').nth(line).evaluate((element, offset) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const node = walker.nextNode()!
      const range = document.createRange()
      range.setStart(node, offset); range.setEnd(node, offset + 1)
      const rect = range.getBoundingClientRect()
      return { x: rect.x + 1, y: rect.y + rect.height / 2 }
    }, offset)
    const start = await point(0, 2), end = await point(2, 6)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 12 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain('第二行被完整选中')
    const backgrounds = page.locator('.source-host .cm-selectionBackground')
    await expect(backgrounds.first()).toBeVisible()
    expect(await backgrounds.first().evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    await expect(source.locator('.cm-activeLine')).toHaveCount(0)
    expect(await page.locator('.source-host .cm-editor').evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none')
    await page.screenshot({ path: `test-results/source-selection-${theme}.png` })
    await source.press('ArrowRight')
    await source.press('Escape')
    await source.press('Tab')
    expect(await source.evaluate((element) => element.contains(document.activeElement))).toBe(false)
    const saved = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()
    expect(saved.content).toBe(content)
  })
}
