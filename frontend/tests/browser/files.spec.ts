import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

const password = 'folio-browser-test-password-2026'
async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
}
async function create(page: Page, kind: '笔记' | '文件夹', name: string) {
  await page.getByRole('button', { name: `新建${kind}`, exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).not.toBeVisible()
}

test('真实目录、Markdown 与 JSON 自动保存，刷新后重新读取', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)
  const folder = `日常笔记-${Date.now()}`
  await create(page, '文件夹', folder)
  await create(page, '笔记', '第一篇.md')
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await rich.fill('中文正文，保存到真实文件。')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await create(page, '笔记', '配置.json')
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await source.fill('{"独立":true}')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await page.getByRole('tab', { name: '第一篇.md' }).click()
  await expect(rich).toContainText('中文正文，保存到真实文件。')
  await page.reload()
  await expect(page.getByRole('button', { name: folder, exact: true })).toBeVisible()
  await page.getByRole('button', { name: folder, exact: true }).click()
  await page.getByRole('button', { name: '第一篇.md', exact: true }).click()
  await expect(rich).toContainText('中文正文，保存到真实文件。')
  await page.screenshot({ path: 'test-results/real-workspace-1440.png' })
  await page.getByRole('button', { name: '配置.json', exact: true }).click()
  await expect(source).toContainText('{"独立":true}')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '关闭文件列表' }).click()
  await page.screenshot({ path: 'test-results/real-workspace-390.png' })
})

test('陈旧版本冲突可比较并另存本地副本，原磁盘版本不覆盖', async ({ page }) => {
  await login(page)
  const name = `冲突-${Date.now()}.md`
  await create(page, '笔记', name)
  await page.getByRole('button', { name: '源码', exact: true }).click()
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  const file = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  // 等本地条件写已发出再修改磁盘，避免干净会话先被 SSE 更新基准。
  await page.route('**/api/v1/files/content?**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    expect(route.request().headers()['if-match']).toBe(`"${file.revision}"`)
    const remoteSave = await page.request.put(`/api/v1/files/content?path=${encodeURIComponent(name)}`, { headers: { 'X-CSRF-Token': principal.csrfToken, 'If-Match': `"${file.revision}"` }, data: { content: '# 其他编辑器的新内容\n' } })
    expect(remoteSave.status()).toBe(200)
    await route.continue()
  })
  const rejected = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/files/content?'))
  await source.fill('我的本地草稿')
  await page.getByRole('button', { name: '保存当前文件' }).click()
  expect((await rejected).status()).toBe(412)
  await expect(page.locator('.save-status')).toContainText('版本冲突')
  const dialog = page.getByRole('dialog', { name: '文件版本发生冲突' })
  await expect(dialog.getByLabel('本地草稿', { exact: true })).toHaveValue('我的本地草稿')
  await expect(dialog.getByLabel('磁盘版本')).toHaveValue('# 其他编辑器的新内容\n')
  await expect(dialog.locator('.diff-delete')).toContainText(['磁盘版本', '# 其他编辑器的新内容'])
  await expect(dialog.locator('.diff-insert')).toContainText(['本地草稿', '我的本地草稿'])
  await dialog.getByRole('button', { name: '保留本地副本并加载磁盘版本' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(source).toContainText('我的本地草稿')
  const latest = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()
  expect(latest.content).toBe('# 其他编辑器的新内容\n')
})

for (const conflict of [false, true]) {
  test(`有损转换预览不写入磁盘，确认后${conflict ? '遵循陈旧 ETag 冲突保护' : '自动保存预览结果'}`, async ({ page }) => {
    await login(page)
    const name = `转换-${conflict}-${Date.now()}.md`
    const original = '---\ntitle: 保留原文\n---\n\n正文\n'
    const principal = await (await page.request.get('/api/v1/auth/me')).json()
    const headers = { 'X-CSRF-Token': principal.csrfToken }
    expect((await page.request.post('/api/v1/files', { headers, data: { path: name, content: original } })).status()).toBe(201)
    const url = `/api/v1/files/content?path=${encodeURIComponent(name)}`
    const initial = await (await page.request.get(url)).json()
    await page.getByRole('button', { name: '刷新文件列表' }).click()
    let writes = 0
    page.on('request', (request) => { if (request.method() === 'PUT') writes++ })
    await page.getByRole('button', { name, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '富文本转换预览' })
    await expect(dialog).toBeVisible()
    const converted = await dialog.getByLabel('转换后 Markdown').inputValue()
    expect(converted).not.toBe(original)
    // 覆盖自动保存防抖窗口，确认预览本身不触发写入。
    await page.waitForTimeout(1100)
    expect(writes).toBe(0)
    expect((await (await page.request.get(url)).json()).content).toBe(original)
    const remote = '# 外部新版本\n'
    if (conflict) await page.route('**/api/v1/files/content?**', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      // 保留已发出的旧 If-Match，远端真实提交后才放行，不伪造 412。
      expect((await page.request.put(url, { headers: { ...headers, 'If-Match': `"${initial.revision}"` }, data: { content: remote } })).status()).toBe(200)
      await route.continue()
    })
    const pendingResponse = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/files/content?'))
    const pendingWrite = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/files/content?'))
    await dialog.getByRole('button', { name: '确认转换并编辑' }).click()
    const write = await pendingWrite
    expect(write.headers()['if-match']).toBe(`"${initial.revision}"`)
    expect(write.postDataJSON().content).toBe(converted)
    expect((await pendingResponse).status()).toBe(conflict ? 412 : 200)
    await expect(page.locator('.save-status')).toContainText(conflict ? '版本冲突' : '已保存')
    expect((await (await page.request.get(url)).json()).content).toBe(conflict ? remote : converted)
    await expect(page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })).toBeVisible()
  })
}
