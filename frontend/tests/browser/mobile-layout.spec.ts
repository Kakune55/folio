import { test, expect } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test('手机长文本行号紧凑，底栏全部内容在固定单行内可见', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).tap()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeAttached()
  const emptyBounds = await page.locator('.draft-recovery-trigger').boundingBox()
  expect(emptyBounds!.x + emptyBounds!.width).toBe(382)
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const name = `手机排版-${Date.now()}.txt`
  const content = Array.from({ length: 12000 }, (_, i) => i < 20 ? `第 ${i + 1} 行 这是一段用于检查手机排版的中文正文，换行后也应该保留足够的阅读宽度。` : `第 ${i + 1} 行`).join('\n')
  expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': me.csrfToken }, data: { path: name, content } })).status()).toBe(201)
  await page.keyboard.press('Control+p')
  const dialog = page.getByRole('dialog', { name: '搜索' })
  await dialog.getByRole('combobox').fill(name)
  await dialog.getByRole('option').filter({ hasText: name }).tap()
  await expect(page.locator('.source-host .cm-editor')).toBeVisible()
  const footer = page.locator('.statusbar')
  await expect(footer.getByRole('button', { name: '正文已索引', exact: true })).toBeVisible()
  for (const width of [390, 320, 430]) {
    await page.setViewportSize({ width, height: 844 })
    const bounds = await page.evaluate(() => {
      const rect = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect()
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
      }
      return { footer: rect('.statusbar'), status: rect('.save-status'), size: rect('.file-size'), index: rect('.file-index-state'), recovery: rect('.draft-recovery-trigger'), gutter: rect('.cm-lineNumbers'), line: rect('.cm-line'), viewport: innerHeight }
    })
    expect(bounds.gutter.width).toBeLessThan(54)
    expect(bounds.line.x).toBeLessThan(56)
    const typography = await page.evaluate(() => {
      const gutter = getComputedStyle(document.querySelector('.cm-lineNumbers')!)
      const text = getComputedStyle(document.querySelector('.cm-content')!)
      return { gutterSize: gutter.fontSize, textSize: text.fontSize, gutterHeight: gutter.lineHeight, textHeight: text.lineHeight }
    })
    expect(typography.gutterSize).toBe(typography.textSize)
    expect(typography.gutterHeight).toBe(typography.textHeight)
    expect(Math.abs(bounds.status.y + bounds.status.height / 2 - bounds.index.y - bounds.index.height / 2)).toBeLessThan(1)
    expect(bounds.footer.height).toBe(41)
    expect(bounds.footer.bottom).toBeLessThanOrEqual(bounds.viewport)
    for (const item of [bounds.status, bounds.size, bounds.index, bounds.recovery]) {
      expect(item.y).toBeGreaterThanOrEqual(bounds.footer.y)
      expect(item.bottom).toBeLessThanOrEqual(bounds.footer.bottom)
      expect(item.x).toBeGreaterThanOrEqual(0)
      expect(item.right).toBeLessThanOrEqual(width)
    }
    expect(bounds.size.right).toBeLessThanOrEqual(bounds.index.x)
    expect(bounds.index.right).toBeLessThanOrEqual(bounds.recovery.x)
    await page.screenshot({ path: `test-results/mobile-text-layout-${width}.png` })
  }
  await footer.getByRole('button', { name: '查看浏览器恢复稿' }).tap()
  await expect(page.getByRole('dialog', { name: /恢复/ })).toBeVisible()
})
