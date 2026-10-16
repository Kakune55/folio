import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
async function prepare(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const name = `搜索笔记-${Date.now()}.md`
  expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path: name, content: '# 搜索验收\n\n网络规划包含交换机。request_id=abc-123。\n' } })).status()).toBe(201)
  await expect.poll(async () => (await (await page.request.get(`/api/v1/search?q=${encodeURIComponent(name)}&mode=names`)).json()).entries?.some((entry: { path: string }) => entry.path === name)).toBe(true)
  return name
}

test('统一搜索名称、中文正文和标识符，两个快捷键打开同一入口', async ({ page }) => {
  const name = await prepare(page)
  await page.keyboard.press('Control+p')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: '搜索', exact: true })).toBeVisible()
  const input = dialog.getByRole('combobox')
  await input.fill(name)
  await expect(dialog.getByRole('option')).toHaveCount(1)
  await input.press('Enter')
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })).toContainText('网络规划包含交换机')
  await expect(page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })).toBeFocused()
  await page.keyboard.press('Control+Shift+f')
  await expect(dialog.getByRole('heading', { name: '搜索', exact: true })).toBeVisible()
  await dialog.getByRole('combobox').fill('交换机')
  await expect(dialog.getByRole('option').filter({ hasText: name })).toBeVisible()
  await dialog.getByRole('combobox').fill('request_id')
  await expect(dialog.getByRole('option').filter({ hasText: name })).toBeVisible()
  await page.screenshot({ path: 'test-results/search-light.png' })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '主题：跟随系统', exact: true }).click()
  await page.getByRole('button', { name: '主题：浅色', exact: true }).click()
  await page.getByRole('button', { name: /^搜索(?: Ctrl P)?$/ }).click()
  await dialog.getByRole('combobox').fill('网络')
  await expect(dialog.getByRole('option').filter({ hasText: name })).toBeVisible()
  await page.screenshot({ path: 'test-results/search-dark.png' })
})

test('索引请求故障不卸载编辑器或丢失未保存正文', async ({ page }) => {
  const name = await prepare(page)
  await page.getByRole('button', { name: /^搜索(?: Ctrl P)?$/ }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').fill(name)
  await expect(dialog.getByRole('option')).toHaveCount(1)
  await dialog.getByRole('combobox').press('Enter')
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await rich.fill('索引不可用时仍能继续书写')
  await page.route('**/api/v1/search?**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'index_unavailable', message: '搜索索引暂时不可用，文件编辑不受影响' } }) }))
  await page.getByRole('button', { name: /^搜索(?: Ctrl P)?$/ }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').fill('完全不同的查询')
  await expect(dialog.getByText('文件搜索失败：搜索索引暂时不可用，文件编辑不受影响', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(rich).toContainText('索引不可用时仍能继续书写')
  await expect(page.locator('.save-status')).toHaveText('已保存')
})

const response = (entries: { path: string; name: string; excerpt: string }[]) => ({ entries, truncated: false, limit: 50, status: { indexing: false, indexedAt: '', files: entries.length } })

test('文件立即可用，内容异步补充去重且保留键盘选择', async ({ page }) => {
  await prepare(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/v1/search?**', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('mode') === 'names') {
      await route.fulfill({ json: response(['alpha.txt', 'beta.json'].map((path) => ({ path, name: path, excerpt: '' }))) })
    } else {
      await gate
      await route.fulfill({ json: response([{ path: 'alpha.txt', name: 'alpha.txt', excerpt: '同时命中正文' }, { path: 'config.yaml', name: 'config.yaml', excerpt: '异步正文命中' }]) })
    }
  })
  await page.getByRole('button', { name: /^搜索(?: Ctrl P)?$/ }).click()
  const dialog = page.getByRole('dialog')
  const input = dialog.getByRole('combobox')
  await input.fill('unified')
  await expect(dialog.getByRole('option')).toHaveCount(2)
  await expect(dialog.getByText('正在查找内容…')).toBeVisible()
  await input.press('ArrowDown')
  await expect(dialog.getByRole('option', { selected: true })).toContainText('beta.json')
  release()
  await expect(dialog.getByRole('option')).toHaveCount(3)
  await expect(dialog.getByRole('option').filter({ hasText: 'alpha.txt' })).toHaveCount(1)
  await expect(dialog.getByRole('option').filter({ hasText: 'alpha.txt' })).toContainText('同时命中正文')
  await expect(dialog.getByRole('option', { selected: true })).toContainText('beta.json')
  await expect(input).toBeFocused()
  await expect(dialog.getByText('异步正文命中')).toBeVisible()
})

test('一类搜索失败保留另一类结果，切换查询不展示迟到结果', async ({ page }) => {
  await prepare(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let oldStarted!: () => void
  const started = new Promise<void>((resolve) => { oldStarted = resolve })
  await page.route('**/api/v1/search?**', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('mode') === 'names') {
      await route.fulfill({ status: 503, json: { error: { code: 'index_unavailable', message: '名称查询故障' } } })
    } else {
      const old = url.searchParams.get('q') === 'old'
      if (old) { oldStarted(); await gate }
      const path = old ? 'old.txt' : 'new.ts'
      await route.fulfill({ json: response([{ path, name: path, excerpt: old ? '过期内容' : '当前内容' }]) })
    }
  })
  await page.getByRole('button', { name: /^搜索(?: Ctrl P)?$/ }).click()
  const dialog = page.getByRole('dialog')
  const input = dialog.getByRole('combobox')
  await input.fill('old')
  await started
  await input.fill('new')
  await expect(dialog.getByText('文件搜索失败：名称查询故障')).toBeVisible()
  await expect(dialog.getByRole('option')).toContainText('new.ts')
  release()
  await expect(dialog.getByText('过期内容')).toHaveCount(0)
  await expect(dialog.getByRole('option')).toHaveCount(1)
})

test('内容先返回时可选择，迟到的文件结果不抢选择或滚动位置', async ({ page }) => {
  await prepare(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/v1/search?**', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('mode') === 'names') {
      if (url.searchParams.get('q') !== 'late') { await route.fulfill({ json: response([]) }); return }
      await gate
      await route.fulfill({ json: response(Array.from({ length: 15 }, (_, i) => ({ path: `file-${i}.txt`, name: `file-${i}.txt`, excerpt: '' }))) })
    } else {
      await route.fulfill({ json: response(['body-a.ts', 'body-b.py'].map((path) => ({ path, name: path, excerpt: '正文命中' }))) })
    }
  })
  await page.getByRole('button', { name: /^搜索(?: Ctrl P)?$/ }).click()
  const dialog = page.getByRole('dialog')
  const input = dialog.getByRole('combobox')
  await input.fill('late')
  await expect(dialog.getByRole('option')).toHaveCount(2)
  await input.press('ArrowDown')
  const selected = dialog.getByRole('option', { selected: true })
  await expect(selected).toContainText('body-b.py')
  await expect(selected).toBeInViewport()
  const before = await selected.boundingBox()
  release()
  await expect(dialog.getByRole('option')).toHaveCount(17)
  await expect(selected).toContainText('body-b.py')
  const after = await selected.boundingBox()
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2)
})

test('正文查询失败时仍可立即回车打开文件', async ({ page }) => {
  const name = await prepare(page)
  await page.route('**/api/v1/search?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('mode') === 'names') await route.continue()
    else await route.fulfill({ status: 503, json: { error: { code: 'index_unavailable', message: '正文查询故障' } } })
  })
  await page.getByRole('button', { name: /^搜索(?: Ctrl P)?$/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').fill(name)
  await expect(dialog.getByRole('option')).toHaveCount(1)
  await expect(dialog.getByText('内容搜索失败：正文查询故障')).toBeVisible()
  await dialog.getByRole('combobox').press('Enter')
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })).toContainText('网络规划包含交换机')
})

test('底栏显示磁盘大小与真实索引状态，保存后更新且手机不溢出', async ({ page }) => {
  const name = await prepare(page)
  await page.getByRole('button', { name: /^搜索(?: Ctrl P)?$/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').fill(name)
  await expect(dialog.getByRole('option')).toHaveCount(1)
  await dialog.getByRole('combobox').press('Enter')
  const footer = page.locator('.statusbar')
  await expect(footer.getByRole('button', { name: '正文已索引', exact: true })).toBeVisible()
  await expect(footer.getByLabel('磁盘文件大小')).toHaveText(/B$/)
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await rich.fill('保存后重新检查索引状态')
  await expect(footer.getByRole('button', { name: '待保存后索引' })).toBeVisible()
  await expect(footer.getByRole('button', { name: '正文已索引', exact: true })).toBeVisible()
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 844 })
    if (width < 768) await page.getByRole('button', { name: '关闭文件列表' }).click()
    await expect(footer.getByLabel('磁盘文件大小')).toBeVisible()
    await expect(footer.getByRole('button', { name: '正文已索引', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const state of ['too_large', 'names_only', 'pending', 'error', 'not_indexed'] as const) {
    await page.route('**/api/v1/search/file-status?**', (route) => route.fulfill({ json: { size: 6 * 1024 ** 2, bodyLimit: 5 * 1024 ** 2, state } }))
    await page.keyboard.press('Control+p')
    await page.getByRole('dialog').getByRole('button', { name: '重建索引', exact: true }).click()
    await page.keyboard.press('Escape')
    const labels = { too_large: '正文超限', names_only: '仅名称索引', pending: '索引更新中…', error: '索引异常', not_indexed: '正文未索引' }
    await expect(footer.getByRole('button', { name: labels[state], exact: true })).toBeVisible()
    await expect(footer.getByLabel('磁盘文件大小')).toHaveText('6 MB')
    if (state === 'too_large') await expect(footer.getByRole('button', { name: labels[state] })).toHaveAttribute('title', /5 MB/)
    await page.unroute('**/api/v1/search/file-status?**')
  }
})
