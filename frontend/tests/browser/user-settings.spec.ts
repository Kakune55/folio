import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

test('用户设置、令牌实际访问与撤销、存储构成和明暗手机布局', async ({ page, playwright }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('link', { name: '用户设置', exact: true })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const headers = { 'X-CSRF-Token': principal.csrfToken }
  const previousQuota = (await (await page.request.get('/api/v1/workspace/usage')).json()).quota
  const filename = `令牌验证-${Date.now()}.txt`
  expect((await page.request.post('/api/v1/files', { headers, data: { path: filename, content: '令牌测试正文' } })).status()).toBe(201)
  await page.getByRole('link', { name: '用户设置', exact: true }).click()
  await expect(page).toHaveURL(/\/user-setting$/)
  await expect(page.getByRole('heading', { name: '账号', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '系统设置', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '应用', exact: true }).click()
  await page.getByLabel('令牌名称', { exact: true }).fill('只读归档应用')
  await page.getByRole('button', { name: '生成令牌', exact: true }).click()
  const secret = await page.getByLabel('Access Token', { exact: true }).inputValue()
  expect(secret).toMatch(/^folio_[a-f0-9]{64}$/)
  await expect(page.getByText('只读归档应用', { exact: true })).toBeVisible()
  const remote = await playwright.request.newContext({ baseURL: new URL(page.url()).origin, extraHTTPHeaders: { Authorization: `Bearer ${secret}` } })
  try {
    const response = await remote.get(`/api/v1/files/content?path=${encodeURIComponent(filename)}`)
    expect(response.status()).toBe(200)
    expect((await response.json()).content).toBe('令牌测试正文')
    expect((await remote.post('/api/v1/files', { data: { path: 'denied.txt', content: 'bad' } })).status()).toBe(403)
    expect((await remote.get('/api/v1/user/tokens')).status()).toBe(403)
    await page.getByRole('button', { name: '我已保存', exact: true }).click()
    await expect(page.getByLabel('Access Token', { exact: true })).toHaveCount(0)
    await page.reload()
    await expect(page.getByText('只读归档应用', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Access Token', { exact: true })).toHaveCount(0)
    // 隔离服务中的真实分类样本，便于检查分段比例。
    expect((await page.request.post('/api/v1/files', { headers, data: { path: `文档样本-${Date.now()}.txt`, content: 'a'.repeat(256 * 1024) } })).status()).toBe(201)
    const trashName = `回收样本-${Date.now()}.txt`
    const trashFile = await (await page.request.post('/api/v1/files', { headers, data: { path: trashName, content: 'b'.repeat(64 * 1024) } })).json()
    expect((await page.request.delete(`/api/v1/entries?path=${encodeURIComponent(trashName)}`, { headers: { ...headers, 'If-Match': `"${trashFile.revision}"` } })).status()).toBe(200)
    const image = await readFile(fileURLToPath(new URL('../fixtures/preview.png', import.meta.url)))
    for (const [name, buffer] of [[`图片样本-${Date.now()}.png`, image], [`其他样本-${Date.now()}.bin`, Buffer.alloc(128 * 1024)] ] as const) {
      expect((await page.request.post('/api/v1/uploads?directory=', { headers, multipart: { file: { name, mimeType: 'application/octet-stream', buffer } } })).status()).toBe(201)
    }
    const selection = await (await page.request.post('/api/v1/shares/analyze', { headers, data: { root: filename, include: false } })).json()
    expect((await page.request.post('/api/v1/shares', { headers, data: { root: filename, title: '存储样本', mode: 'snapshot', files: selection.files.map((f: { path: string; revision: string }) => ({ path: f.path, revision: f.revision })), expiresAt: 0, maxVisits: 0, disabled: false } })).status()).toBe(201)
    expect((await page.request.patch(`/api/v1/admin/users/${principal.id}`, { headers, data: { username: principal.username, enabled: true, quota: 1024 * 1024, password: '' } })).status()).toBe(200)
    const output = fileURLToPath(new URL('../../../artifacts/user-settings/', import.meta.url))
    await mkdir(output, { recursive: true })
    for (const tab of ['应用', '存储', '账号']) {
      await page.getByRole('button', { name: tab, exact: true }).click()
      if (tab === '存储') {
        await expect(page.getByRole('img', { name: /^存储构成/ })).toBeVisible()
        const details = await (await page.request.get('/api/v1/workspace/storage')).json()
        const usage = await (await page.request.get('/api/v1/workspace/usage')).json()
        expect(details.used).toBe(usage.used)
        expect(details.categories.reduce((n: number, c: { bytes: number }) => n + c.bytes, 0)).toBe(details.used)
      }
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 900 })
        for (const theme of ['light', 'dark']) {
          await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
          if (width !== 1024) await page.screenshot({ path: `${output}/${tab}-${width}-${theme}.png`, fullPage: true })
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: '应用', exact: true }).click()
    // 失败可见且可重试，不伪装空状态。
    await page.route('**/api/v1/workspace/storage', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal_error', message: '测试统计故障' } }) }))
    await page.getByRole('button', { name: '存储', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('测试统计故障')
    await page.unroute('**/api/v1/workspace/storage')
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByRole('img', { name: /^存储构成/ })).toBeVisible()
    await page.getByRole('button', { name: '应用', exact: true }).click()
    await page.getByRole('button', { name: '删除令牌 只读归档应用', exact: true }).click()
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.getByText('只读归档应用', { exact: true })).toHaveCount(0)
    expect((await remote.get('/api/v1/workspace/tree')).status()).toBe(401)
    await page.getByRole('link', { name: '系统设置', exact: true }).click()
    await expect(page.getByRole('heading', { name: '系统设置', exact: true })).toBeVisible()
    await expect(page.locator('.settings-header-links')).toHaveText('用户设置admin')
    await expect(page.locator('.settings-header-links a')).toHaveCount(1)
    await page.screenshot({ path: `${output}/系统设置顶栏.png`, fullPage: true })
    await page.getByRole('link', { name: '用户设置', exact: true }).click()
    await expect(page.locator('.settings-header-links')).toHaveText('系统设置admin')
    await expect(page.getByRole('heading', { name: '用户设置', exact: true })).toBeVisible()
  } finally {
    await page.request.patch(`/api/v1/admin/users/${principal.id}`, { headers, data: { username: principal.username, enabled: true, quota: previousQuota, password: '' } })
    await remote.dispose()
  }
})
