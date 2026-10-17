import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('大纲准确定位重复标题、实时更新并保持实例；文本缩略图跳转与响应式主题', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const id = Date.now()
  const md = `大纲-${id}.md`, txt = `缩略-${id}.json`
  const original = '# 同名\n\n' + '段落内容。\n\n'.repeat(120) + '## 同名\n\n末尾正文。\n'
  for (const [path, content] of [[md, original], [txt, Array.from({ length: 700 }, (_, n) => `{"line": ${n}}`).join('\n')]]) {
    expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path, content } })).status()).toBe(201)
  }
  const open = async (name: string) => {
    await page.keyboard.press('Control+p')
    await page.getByRole('combobox').fill(name)
    await page.getByRole('option').filter({ hasText: name }).click()
  }
  await open(md)
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await expect(rich).toBeVisible()
  await rich.evaluate((element) => element.setAttribute('data-instance', 'original'))
  await page.getByRole('button', { name: '展开大纲与缩略图' }).click()
  const navigation = page.getByRole('navigation', { name: '标题导航' })
  await expect(navigation.getByRole('button', { name: '同名', exact: true })).toHaveCount(2)
  await navigation.getByRole('button', { name: '同名', exact: true }).nth(1).click()
  await expect(rich.locator('h2')).toBeInViewport()
  await page.keyboard.insertText('更新')
  await expect(navigation.getByRole('button', { name: '更新同名', exact: true })).toBeVisible()
  await rich.press('Control+z')
  await expect(navigation.getByRole('button', { name: '同名', exact: true })).toHaveCount(2)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: '../artifacts/navigation/navigation-rich-desktop.png' })
  await page.getByRole('button', { name: '收起大纲与缩略图' }).click()
  await expect(rich).toHaveAttribute('data-instance', 'original')
  expect((await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(md)}`)).json()).content).toBe(original)
  await page.getByRole('button', { name: '源码', exact: true }).click()
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await expect(source).toBeVisible()
  await page.getByRole('button', { name: '展开大纲与缩略图' }).click()
  await navigation.getByRole('button', { name: '同名', exact: true }).nth(1).click()
  await expect(source.locator('.cm-line').filter({ hasText: '## 同名' })).toBeInViewport()
  await source.press('Control+End')
  await page.keyboard.insertText('\n## 新增标题\n')
  await expect(navigation.getByRole('button', { name: '新增标题' })).toBeVisible()
  await open(txt)
  const slider = page.getByRole('slider', { name: '文本位置' })
  await expect(slider).toBeVisible()
  await slider.focus(); await slider.press('End')
  await expect(source.locator('.cm-line').filter({ hasText: '{"line": 699}' })).toBeInViewport()
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const close = page.getByRole('button', { name: '关闭文件列表' })
    if (await close.isVisible()) await close.click()
    await expect(slider).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  }
  await page.screenshot({ path: '../artifacts/navigation/navigation-mobile.png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: '../artifacts/navigation/navigation-minimap-desktop.png' })
})

test('十万行抽象缩略图绘制有界，连续滚动只移动遮罩，编辑与主题变化仍刷新', async ({ page }) => {
  await page.addInitScript(() => {
    const fillRect = CanvasRenderingContext2D.prototype.fillRect
    const fillText = CanvasRenderingContext2D.prototype.fillText
    const scale = CanvasRenderingContext2D.prototype.scale
    CanvasRenderingContext2D.prototype.scale = function (...args) {
      if (this.canvas.getAttribute('aria-label') === '文本位置') {
        this.canvas.dataset.rectangles = '0'
        this.canvas.dataset.draws = String(Number(this.canvas.dataset.draws || 0) + 1)
      }
      return scale.apply(this, args)
    }
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas.getAttribute('aria-label') === '文本位置') this.canvas.dataset.rectangles = String(Number(this.canvas.dataset.rectangles || 0) + 1)
      return fillRect.apply(this, args)
    }
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (this.canvas.getAttribute('aria-label') === '文本位置') this.canvas.dataset.glyphs = '绘制了字体'
      return fillText.apply(this, args)
    }
  })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const name = `抽象-${Date.now()}.txt`
  const content = Array.from({ length: 100_000 }, (_, n) => `${' '.repeat(n % 12)}第 ${n} 行内容`).join('\n')
  expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path: name, content } })).status()).toBe(201)
  await page.keyboard.press('Control+p')
  await page.getByRole('combobox').fill(name)
  await page.getByRole('option').filter({ hasText: name }).click()
  await page.getByRole('button', { name: '展开大纲与缩略图' }).click()
  const canvas = page.getByRole('slider', { name: '文本位置' })
  await expect(canvas).toHaveAttribute('data-rectangles', /\d+/)
  const count = Number(await canvas.getAttribute('data-rectangles'))
  const height = (await canvas.boundingBox())!.height
  expect(count).toBeLessThanOrEqual(Math.ceil(height / 3))
  const draws = Number(await canvas.getAttribute('data-draws'))
  const overlay = page.locator('.minimap-viewport')
  const initialTransform = await overlay.evaluate((element) => element.style.transform)
  await page.locator('.cm-scroller').evaluate((element) => { element.scrollTop = element.scrollHeight / 2 })
  await expect.poll(() => overlay.evaluate((element) => element.style.transform)).not.toBe(initialTransform)
  // 超过内容刷新防抖窗口，确认滚动没有延迟重绘。
  await page.waitForTimeout(250)
  await expect(canvas).toHaveAttribute('data-draws', String(draws))
  await expect(canvas).not.toHaveAttribute('data-glyphs')
  await page.evaluate(() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
  await expect.poll(async () => Number(await canvas.getAttribute('data-draws'))).toBeGreaterThan(draws)
  const themedCount = Number(await canvas.getAttribute('data-draws'))
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await source.press('Control+End')
  await page.keyboard.insertText('\n新增行')
  await expect(canvas).toHaveAttribute('aria-valuemax', '100001')
  await expect.poll(async () => Number(await canvas.getAttribute('data-draws'))).toBeGreaterThan(themedCount)
  await page.screenshot({ path: '../artifacts/navigation/navigation-abstract-large.png' })
})
