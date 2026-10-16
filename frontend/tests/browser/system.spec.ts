import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('系统设置在线生效、失败保留，系统状态明暗和手机布局', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await page.getByRole('link', { name: '系统设置', exact: true }).click()
  const initial = await (await page.request.get('/api/v1/admin/settings')).json()
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const headers = { 'X-CSRF-Token': me.csrfToken }
  try {
    await page.getByRole('button', { name: '系统设置', exact: true }).click()
    await expect(page.getByLabel('正文索引上限')).toBeVisible()
    await page.getByLabel('正文索引上限').fill('2')
    await page.getByLabel('附件大小上限').fill('1')
    await page.getByLabel('图片大小上限').fill('1')
    await page.getByLabel('PDF 大小上限').fill('1')
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByRole('status')).toContainText('设置已生效')
    const settings = await (await page.request.get('/api/v1/admin/settings')).json()
    expect(settings.indexLimit).toBe(2 * 1024 ** 2)
    const publicSettings = await (await page.request.get('/api/v1/settings')).json()
    expect(publicSettings.limits.attachment).toBe(1024 ** 2)
    const upload = await page.request.post('/api/v1/uploads?directory=', { headers, multipart: { file: { name: `over-${Date.now()}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 ** 2 + 1, 0) } } })
    expect(upload.status()).toBe(413)
    await page.reload()
    await page.getByRole('button', { name: '系统设置', exact: true }).click()
    await expect(page.getByLabel('正文索引上限')).toHaveValue('2')
    await page.route('**/api/v1/admin/settings', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 500, json: { error: { message: '测试保存失败' } } }) : route.continue())
    await page.getByLabel('正文索引上限').fill('3')
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByRole('alert')).toContainText('测试保存失败')
    await expect(page.getByLabel('正文索引上限')).toHaveValue('3')
    await page.unroute('**/api/v1/admin/settings')
    for (const section of ['系统设置', '系统状态']) {
      await page.getByRole('button', { name: section, exact: true }).click()
      if (section === '系统状态') {
        await expect(page.getByText('当前 Goroutines 数量')).toBeVisible()
        await page.getByRole('button', { name: '统计磁盘用量' }).click()
        await expect(page.getByText('全部工作区文件', { exact: true })).toBeVisible()
        await expect(page.getByText(/所在磁盘：可用/)).toHaveCount(2)
        await page.getByLabel('每 5 秒刷新').uncheck()
      }
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, theme)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
          await page.screenshot({ path: `test-results/system-${section}-${width}-${theme}.png`, fullPage: true })
        }
      }
    }
  } finally {
    await page.unroute('**/api/v1/admin/settings')
    expect((await page.request.put('/api/v1/admin/settings', { headers, data: initial })).status()).toBe(200)
  }
})
