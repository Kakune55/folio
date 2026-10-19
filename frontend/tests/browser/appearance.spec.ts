import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('个性化即时应用、持久保存、移动布局与编辑器实例保护', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 2200, height: 1000 })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const path = `个性化-${Date.now()}.md`, content = '# 个性化\n\n正文保持原样。\n'
  expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path, content } })).status()).toBe(201)
  const openFile = async () => {
    await page.keyboard.press('Control+p')
    await page.getByRole('combobox').fill(path)
    await page.getByRole('option').filter({ hasText: path }).click()
  }
  await openFile()
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器', includeHidden: true })
  await expect(rich).toBeVisible()
  await rich.evaluate(el => el.setAttribute('data-instance', 'original'))
  const settings = page.getByRole('button', { name: '个性化', exact: true })
  await settings.click()
  const dialog = page.getByRole('dialog', { name: '个性化', exact: true })
  await expect(dialog.getByRole('radio', { name: '中 1200 px' })).toBeChecked()
  for (const [label, width] of [['窄', 800], ['中', 1200], ['宽', 1600]] as const) {
    await dialog.getByRole('radio', { name: `${label} ${width} px` }).check()
    await expect.poll(() => rich.evaluate(el => Math.round(el.getBoundingClientRect().width))).toBe(width)
  }
  await dialog.getByRole('radio', { name: '大 18 px' }).check()
  await expect(rich).toHaveCSS('font-size', '18px')
  await expect(rich).toHaveAttribute('data-instance', 'original')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  }
  await page.screenshot({ path: '../artifacts/appearance-desktop.png' })
  await dialog.press('Escape')
  await expect(settings).toBeFocused()
  expect((await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)).json()).content).toBe(content)
  await page.reload()
  await settings.click()
  await expect(dialog.getByRole('radio', { name: '宽 1600 px' })).toBeChecked()
  await expect(dialog.getByRole('radio', { name: '大 18 px' })).toBeChecked()
  await dialog.getByRole('button', { name: '完成' }).click()
  await openFile()
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    const close = page.getByRole('button', { name: '关闭文件列表' })
    if (await close.isVisible()) await close.click()
    await settings.click()
    await expect(dialog).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (width < 768) {
      await dialog.getByRole('radio', { name: '窄 800 px' }).check()
      const narrow = await rich.evaluate(el => el.getBoundingClientRect().width)
      await dialog.getByRole('radio', { name: '宽 1600 px' }).check()
      expect(await rich.evaluate(el => el.getBoundingClientRect().width)).toBe(narrow)
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    }
    await dialog.getByRole('button', { name: '完成' }).click()
  }
  await settings.click()
  await dialog.getByRole('button', { name: '恢复默认' }).click()
  await expect(dialog.getByRole('radio', { name: '中 1200 px' })).toBeChecked()
  await expect(dialog.getByRole('radio', { name: '标准 16 px' })).toBeChecked()
  await page.screenshot({ path: '../artifacts/appearance-mobile.png' })
  await dialog.press('Escape')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(page.locator('.cm-editor')).toHaveCSS('font-size', '16px')
})
