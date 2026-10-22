import { test, expect, chromium } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

async function prepare(page: Page, nested = false) {
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '查看浏览器恢复稿' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const name = `恢复验收-${Date.now()}`, path = nested ? `${name}/笔记.json` : `${name}.json`
  const headers = { 'X-CSRF-Token': principal.csrfToken }
  if (nested) expect((await page.request.post('/api/v1/directories', { headers, data: { path: name } })).status()).toBe(201)
  expect((await page.request.post('/api/v1/files', { headers, data: { path, content: '{"disk":true}' } })).status()).toBe(201)
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  if (nested) await page.getByRole('button', { name, exact: true }).click()
  await page.getByRole('button', { name: nested ? '笔记.json' : path, exact: true }).click()
  await expect(page.getByRole('textbox', { name: '源码编辑器' })).toBeVisible()
  return { path, name, scope: principal.workspaceId as string }
}
async function records(page: Page) {
  return page.evaluate(async () => new Promise<{ path: string; source: string; scope: string; id: string }[]>((resolve, reject) => {
    const request = indexedDB.open('folio-recovery', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('drafts', 'readonly'), query = transaction.objectStore('drafts').getAll()
      transaction.oncomplete = () => { db.close(); resolve(query.result) }; transaction.onabort = () => { db.close(); reject(transaction.error) }
    }
  }))
}
async function blockSaves(page: Page) {
  await page.route('**/api/v1/files/content?**', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'test_offline', message: '测试网络中断' } }) }) : route.continue())
}

test('连续脏输入持久化，刷新后显式恢复并手动保存，成功后清理自己的记录', async ({ page }) => {
  const { path, scope } = await prepare(page)
  await blockSaves(page)
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await source.fill('第一轮未保存'); await expect.poll(async () => (await records(page)).some((draft) => draft.source === '第一轮未保存')).toBe(true)
  await source.fill('最后一轮未保存：中文和 request_id')
  await expect.poll(async () => (await records(page)).find((draft) => draft.path === path)?.source).toBe('最后一轮未保存：中文和 request_id')
  await expect(page.locator('.save-status')).toContainText('保存失败')
  // 其他工作区的记录不能因同网址登录而进入当前恢复列表。
  await page.evaluate(async ({ scope }) => new Promise<void>((resolve) => {
    const request = indexedDB.open('folio-recovery', 1)
    request.onsuccess = () => { const db = request.result, transaction = db.transaction('drafts', 'readwrite'); transaction.objectStore('drafts').put({ id: 'unknown', scope, version: 99, source: '未知格式正文，不能丢弃', path: '旧格式.md', updatedAt: Date.now() }); transaction.objectStore('drafts').put({ id: 'foreign', scope: `${scope}-other`, source: '其他目录的秘密', path: '不属于当前工作区.md' }); transaction.oncomplete = () => { db.close(); resolve() } }
  }), { scope })
  await page.reload()
  await page.getByRole('button', { name: '查看浏览器恢复稿' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('不属于当前工作区.md', { exact: true })).not.toBeVisible()
  await dialog.getByRole('button').filter({ hasText: '格式不受支持的恢复记录' }).click()
  await expect(dialog.getByLabel('浏览器草稿正文')).toContainText('未知格式正文，不能丢弃')
  await expect(dialog.getByRole('button', { name: '打开为待确认草稿' })).not.toBeVisible()
  const exported = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '下载恢复稿', exact: true }).click()
  expect(JSON.parse(await readFile((await (await exported).path())!, 'utf8')).source).toBe('未知格式正文，不能丢弃')
  await dialog.getByRole('button', { name: '删除这条浏览器记录…' }).click()
  await dialog.getByRole('button', { name: '取消删除', exact: true }).click()
  expect((await records(page)).some((draft) => draft.id === 'unknown')).toBe(true)
  await dialog.getByRole('button', { name: '删除这条浏览器记录…' }).click()
  await dialog.getByRole('button', { name: '确认删除浏览器记录', exact: true }).click()
  await expect(dialog.getByRole('button').filter({ hasText: '格式不受支持的恢复记录' })).not.toBeVisible()
  await dialog.getByRole('button').filter({ hasText: path }).click()
  await expect(dialog.getByLabel('浏览器草稿正文')).toHaveValue('最后一轮未保存：中文和 request_id')
  await expect(dialog.getByLabel('当前磁盘正文')).toHaveValue('{"disk":true}')
  await page.screenshot({ path: 'test-results/draft-recovery-light.png' })
  await dialog.getByRole('button', { name: '打开为待确认草稿' }).click()
  await expect(dialog.getByText('该文件已有标签页，请先保存并关闭，或把恢复稿另存为新文件', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('tab', { name: path, exact: true }).press('Delete')
  await page.getByRole('button', { name: '查看浏览器恢复稿' }).click()
  await dialog.getByRole('button').filter({ hasText: path }).click()
  await dialog.getByRole('button', { name: '打开为待确认草稿' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(source).toContainText('最后一轮未保存')
  await expect(page.getByText('浏览器恢复稿已加载，请核对正文后手动保存', { exact: true })).toBeVisible()
  expect((await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)).json()).content).toBe('{"disk":true}')
  await page.unroute('**/api/v1/files/content?**')
  await page.getByRole('button', { name: '保存当前文件' }).click()
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await expect.poll(async () => (await records(page)).filter((draft) => draft.scope === scope)).toHaveLength(0)
})

test('目录移走后另存恢复副本，首次失败保留缓存，成功不覆盖被移走原件', async ({ page }) => {
  const { path, name } = await prepare(page, true)
  await blockSaves(page)
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await source.click(); await source.press('Control+a'); await page.keyboard.insertText('可恢复的完整正文')
  await expect.poll(async () => (await records(page)).find((draft) => draft.path === path)?.source).toBe('可恢复的完整正文')
  const root = (await readFile(resolve('../artifacts/browser-workspace-path'), 'utf8')).trim()
  await rename(join(root, name), join(root, `${name}-移走`))
  await page.reload()
  await page.getByRole('button', { name: '查看浏览器恢复稿' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button').filter({ hasText: path }).click()
  await expect(dialog.getByText(/磁盘版本尚未核对/)).toBeVisible()
  await dialog.getByRole('button', { name: '另存恢复副本', exact: true }).click()
  await expect(dialog.getByText('文件或目录不存在', { exact: true })).toBeVisible()
  expect((await records(page)).find((draft) => draft.path === path)?.source).toBe('可恢复的完整正文')
  const copy = `${name}-新副本.json`
  await dialog.getByLabel('恢复副本路径').fill(copy)
  await dialog.getByRole('button', { name: '另存恢复副本', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(await readFile(join(root, copy), 'utf8')).toBe('可恢复的完整正文')
  expect(await readFile(join(root, `${name}-移走/笔记.json`), 'utf8')).toBe('{"disk":true}')
  await expect.poll(async () => (await records(page)).filter((draft) => draft.path === path)).toHaveLength(0)
})

test('两个页面同路径草稿使用独立记录，刷新后两份均可恢复', async ({ page, context }) => {
  const { path } = await prepare(page)
  await context.route('**/api/v1/files/content?**', (route) => route.request().method() === 'PUT' ? route.abort() : route.continue())
  const first = page.getByRole('textbox', { name: '源码编辑器' })
  await first.click(); await first.press('Control+a'); await page.keyboard.insertText('页面甲的版本')
  await expect.poll(async () => (await records(page)).find((draft) => draft.path === path)?.source).toBe('页面甲的版本')
  const other = await context.newPage(); other.on('dialog', (dialog) => void dialog.accept())
  await other.goto('/'); await other.getByRole('button', { name: path, exact: true }).click()
  const second = other.getByRole('textbox', { name: '源码编辑器' })
  await second.click(); await second.press('Control+a'); await other.keyboard.insertText('页面乙的版本')
  await expect.poll(async () => (await records(page)).filter((draft) => draft.path === path).map((draft) => draft.source).sort()).toEqual(['页面乙的版本', '页面甲的版本'].sort())
  await other.close(); await page.reload()
  await page.getByRole('button', { name: '查看浏览器恢复稿' }).click()
  await expect(page.getByRole('dialog').getByRole('button').filter({ hasText: path })).toHaveCount(2)
})

test('浏览器禁止恢复存储时显式提示，正文可保存和下载', async ({ page, context }) => {
  await context.addInitScript(() => { Object.defineProperty(indexedDB, 'open', { value: () => { throw new DOMException('测试禁止本地存储', 'SecurityError') } }) })
  const { path } = await prepare(page)
  await expect(page.getByText(/浏览器恢复副本未能更新/)).toBeVisible()
  await page.getByRole('textbox', { name: '源码编辑器' }).fill('存储故障仍能保存的正文')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载当前草稿' }).click()
  expect(await readFile((await (await download).path())!, 'utf8')).toBe('存储故障仍能保存的正文')
  expect((await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)).json()).content).toBe('存储故障仍能保存的正文')
})

test('实际关闭并重新启动独立浏览器配置后，仍能读取未保存恢复稿', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'folio-draft-profile-'))
  const launch = () => chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'], baseURL: 'http://127.0.0.1:5173' })
  let browser = await launch()
  try {
    const page = browser.pages()[0]
    const { path } = await prepare(page)
    await blockSaves(page)
    const editor = page.getByRole('textbox', { name: '源码编辑器' })
    await editor.click(); await editor.press('Control+a'); await page.keyboard.insertText('浏览器重启前的最后正文')
    await expect.poll(async () => (await records(page)).find((draft) => draft.path === path)?.source).toBe('浏览器重启前的最后正文')
    await browser.close()
    browser = await launch()
    const reopened = browser.pages()[0]
    await reopened.goto('/')
    await reopened.getByRole('button', { name: '查看浏览器恢复稿' }).click()
    const dialog = reopened.getByRole('dialog')
    await dialog.getByRole('button').filter({ hasText: path }).click()
    await expect(dialog.getByLabel('浏览器草稿正文')).toHaveValue('浏览器重启前的最后正文')
    expect((await (await reopened.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)).json()).content).toBe('{"disk":true}')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await reopened.getByRole('button', { name: '主题：跟随系统', exact: true }).click()
    await reopened.getByRole('button', { name: '主题：浅色', exact: true }).click()
    await reopened.getByRole('button', { name: '查看浏览器恢复稿' }).click()
    await dialog.getByRole('button').filter({ hasText: path }).click()
    await expect(dialog.getByLabel('浏览器草稿正文')).toHaveValue('浏览器重启前的最后正文')
    await reopened.screenshot({ path: 'test-results/draft-recovery-dark.png' })
    await reopened.setViewportSize({ width: 390, height: 844 })
    await reopened.screenshot({ path: 'test-results/draft-recovery-mobile.png' })
  } finally { await browser.close(); await rm(profile, { recursive: true, force: true }) }
})
