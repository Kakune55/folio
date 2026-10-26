import { test, expect } from '@playwright/test'
import type { Page, Playwright } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

async function prepare(page: Page, playwright: Playwright, content: string, extension = 'txt') {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  const connected = page.waitForResponse(response => response.url().includes('/workspace/events?') && response.status() === 200)
  await page.getByRole('button', { name: '进入工作区' }).click()
  await connected
  const showFiles = page.getByRole('button', { name: '展开文件列表', exact: true })
  if (await showFiles.isVisible()) await showFiles.click()
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const headers = { 'X-CSRF-Token': me.csrfToken }
  const path = `实时变更-${Date.now()}.${extension}`
  const created = await (await page.request.post('/api/v1/files', { headers, data: { path, content } })).json()
  await expect(page.getByRole('button', { name: path, exact: true })).toBeVisible()
  await page.getByRole('button', { name: path, exact: true }).click()
  const token = await (await page.request.post('/api/v1/user/tokens', { headers, data: { name: 'SSE 验收 Agent', expiresAt: 0, permissions: { files: 'write', search: 'read', trash: 'write' } } })).json()
  const agent = await playwright.request.newContext({ baseURL: new URL(page.url()).origin, extraHTTPHeaders: { Authorization: `Bearer ${token.token}` } })
  const url = `/api/v1/files/content?path=${encodeURIComponent(path)}`
  return { agent, url, path, revision: created.revision }
}
const output = fileURLToPath(new URL('../../../artifacts/sse/', import.meta.url))

// 只改变 Date，250ms 通知刷新、50ms SSE 合并和网络连接仍按真实时间运行。
async function advanceNoticeTime(page: Page, milliseconds: number) {
  await page.clock.setFixedTime(await page.evaluate(() => Date.now()) + milliseconds)
}

function contentWrites(page: Page) {
  const writes: { method: string; match: string | undefined; content: unknown }[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/v1/files/content' && ['PUT', 'PATCH'].includes(request.method())) {
      writes.push({ method: request.method(), match: request.headers()['if-match'], content: request.postDataJSON() })
    }
  })
  return writes
}

test('Agent 更新即时加载、黄绿标记与删除红三角、接受清除和断线重连', async ({ page, playwright }) => {
  await page.clock.setFixedTime(new Date())
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const old = 'head\nold\nanchor-a\ndelete-me\nanchor-b\nanchor-c\nend\n'
  const next = 'head\nnew\ninserted\nanchor-a\nanchor-b\nanchor-c\nend\n'
  const { agent, url, revision } = await prepare(page, playwright, old)
  try {
    const editor = page.getByRole('textbox', { name: '源码编辑器' })
    await expect(editor).toContainText('delete-me')
    const writes: string[] = []; page.on('request', request => { if (request.url().includes('/files/content?') && ['PUT', 'PATCH'].includes(request.method())) writes.push(request.url()) })
    expect((await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: next } })).status()).toBe(200)
    await expect(editor).toContainText('inserted', { timeout: 4000 })
    await expect(editor).not.toContainText('delete-me')
    await expect(page.locator('.remote-notice')).toHaveCount(1)
    await expect(page.locator('.remote-notice')).toContainText('来自应用 SSE 验收 Agent')
    await expect(page.locator('.external-gutter-mark.external-modified')).toHaveCount(1)
    await expect(page.locator('.external-gutter-mark.external-inserted')).toHaveCount(1)
    await expect(page.locator('.external-gutter-mark.external-deleted')).toHaveCount(1)
    await mkdir(output, { recursive: true })
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const closeDrawer = page.getByRole('button', { name: '关闭文件列表', exact: true })
      if (await closeDrawer.isVisible()) await closeDrawer.click()
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: `${output}/source-${width}-${theme}.png` })
      }
    }
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.locator('.remote-notice').getByRole('button', { name: /^接受/ }).click()
    await expect(page.locator('.remote-notice')).toHaveCount(0)
    await expect(page.locator('.external-gutter-mark')).toHaveCount(0)
    await expect(editor).toContainText('inserted')
    expect(writes).toEqual([])
    const disk = await (await agent.get(url)).json()
    await page.context().setOffline(true)
    await expect(page.getByText(/实时通知.*(?:断开|暂停)/)).toBeVisible()
    expect((await agent.put(url, { headers: { 'If-Match': `"${disk.revision}"` }, data: { content: next + '离线期间的新内容\n' } })).status()).toBe(200)
    await page.context().setOffline(false)
    await expect(editor).toContainText('离线期间的新内容', { timeout: 6000 })
    expect(errors).toEqual([])
  } finally { await page.context().setOffline(false); await agent.dispose() }
})

test('本地草稿不被替换，手动保存和快捷键打开差异确认', async ({ page, playwright }) => {
  const { agent, url, revision } = await prepare(page, playwright, '原始正文\n')
  try {
    const editor = page.getByRole('textbox', { name: '源码编辑器' })
    await expect(editor).toContainText('原始正文')
    await editor.fill('保留本地草稿')
    expect((await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: 'Agent 的远端正文\n' } })).status()).toBe(200)
    await expect(page.locator('.save-status')).toContainText('版本冲突')
    await expect(editor).toHaveText('保留本地草稿')
    await expect(page.locator('.remote-notice')).toContainText('来自应用 SSE 验收 Agent')
    await expect(page.locator('.remote-notice').getByRole('button', { name: '等待', exact: true })).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: '保存当前文件', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '文件版本发生冲突' })
    await expect(dialog.getByLabel('本地草稿', { exact: true })).toHaveValue('保留本地草稿')
    await expect(dialog.getByLabel('磁盘版本', { exact: true })).toHaveValue('Agent 的远端正文\n')
    await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/conflict.png` })
    await dialog.getByRole('button', { name: '稍后处理' }).click()
    await page.keyboard.press('ControlOrMeta+s')
    await expect(dialog).toBeVisible()
    const copy = await dialog.getByLabel('副本路径').inputValue()
    await dialog.getByRole('button', { name: '保留本地副本并加载磁盘版本' }).click()
    await expect(dialog).not.toBeVisible()
    expect((await (await agent.get(url)).json()).content).toBe('Agent 的远端正文\n')
    expect((await (await agent.get('/api/v1/files/content?path=' + encodeURIComponent(copy))).json()).content).toBe('保留本地草稿')
  } finally { await agent.dispose() }
})

test('干净正文即时显示原生差异标记，右下通知仅提供来源、增删统计和处理操作', async ({ page, playwright }) => {
  await page.clock.setFixedTime(new Date())
  const before = '共同首行\n首轮旧正文\n共同末行\n'
  const remote = '共同首行\n应用新正文\n应用新增行\n共同末行\n'
  const { agent, url, path, revision } = await prepare(page, playwright, before)
  try {
    const editor = page.getByRole('textbox', { name: '源码编辑器' })
    await expect(editor).toContainText('首轮旧正文')
    const writes = contentWrites(page)
    expect((await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: remote } })).status()).toBe(200)
    await expect(editor).toContainText('应用新增行', { timeout: 4000 })
    await expect(editor).not.toContainText('首轮旧正文')
    await expect(page.locator('.external-gutter-mark.external-modified')).toHaveCount(1)
    await expect(page.locator('.external-gutter-mark.external-inserted')).toHaveCount(1)
    const notice = page.locator('.remote-notice')
    await expect(notice).toHaveCount(1)
    await expect(notice).toContainText(path)
    await expect(notice).toContainText('来自应用 SSE 验收 Agent')
    await expect(notice.getByLabel('差异：新增 2 行，删除 1 行', { exact: true })).toBeVisible()
    await expect(notice.locator('.remote-inserted')).toHaveText('+2')
    await expect(notice.locator('.remote-deleted')).toHaveText('-1')
    await expect(notice.getByRole('button', { name: '接受（10s）', exact: true })).toBeVisible()
    await expect(notice.getByRole('button', { name: '等待', exact: true })).toBeVisible()
    await expect(notice.getByRole('button', { name: '回滚', exact: true })).toBeVisible()
    const box = await notice.boundingBox()
    const viewport = page.viewportSize()!
    expect(box).not.toBeNull()
    expect(box!.x + box!.width / 2).toBeGreaterThan(viewport.width / 2)
    expect(box!.y + box!.height / 2).toBeGreaterThan(viewport.height / 2)
    await expect(notice.getByRole('button')).toHaveText(['接受（10s）', '等待', '回滚'])
    await expect(notice.getByRole('button', { name: /Diff/i })).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const diskBeforeAccept = await (await agent.get(url)).json()
    await notice.getByRole('button', { name: /^接受/ }).click()
    await expect(notice).toHaveCount(0)
    await expect(page.locator('.external-gutter-mark')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(editor).toContainText('应用新增行')
    expect(writes).toEqual([])
    const diskAfterAccept = await (await agent.get(url)).json()
    expect(diskAfterAccept.content).toBe(remote)
    expect(diskAfterAccept.revision).toBe(diskBeforeAccept.revision)
  } finally { await agent.dispose() }
})

test('同文件通知合并并从最新变化重计 10 秒，自动接受清除通知和标记但不写磁盘', async ({ page, playwright }) => {
  await page.clock.setFixedTime(new Date())
  const { agent, url, revision } = await prepare(page, playwright, '首轮之前\n')
  try {
    const editor = page.getByRole('textbox', { name: '源码编辑器' })
    await expect(editor).toContainText('首轮之前')
    const writes = contentWrites(page)
    const first = await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: '第一轮更新\n' } })
    expect(first.status()).toBe(200)
    await expect(editor).toContainText('第一轮更新', { timeout: 4000 })
    const notice = page.locator('.remote-notice')
    await expect(notice.getByRole('button', { name: '接受（10s）', exact: true })).toBeVisible()
    await advanceNoticeTime(page, 6000)
    await expect(notice.getByRole('button', { name: '接受（4s）', exact: true })).toBeVisible()
    const second = await agent.put(url, { headers: { 'If-Match': `"${(await first.json()).revision}"` }, data: { content: '第二轮更新\n合并新增行\n' } })
    expect(second.status()).toBe(200)
    const secondRevision = (await second.json()).revision
    await expect(editor).toContainText('合并新增行', { timeout: 4000 })
    await expect(notice).toHaveCount(1)
    await expect(notice.getByRole('button', { name: '接受（10s）', exact: true })).toBeVisible()
    await expect(notice.getByLabel('差异：新增 2 行，删除 1 行', { exact: true })).toBeVisible()
    await advanceNoticeTime(page, 5000)
    await expect(notice.getByRole('button', { name: '接受（5s）', exact: true })).toBeVisible()
    await advanceNoticeTime(page, 4000)
    await expect(notice.getByRole('button', { name: '接受（1s）', exact: true })).toBeVisible()
    await expect(page.locator('.external-gutter-mark.external-modified')).toHaveCount(1)
    await advanceNoticeTime(page, 1000)
    await expect(notice).toHaveCount(0)
    await expect(page.locator('.external-gutter-mark')).toHaveCount(0)
    await expect(editor).toContainText('第二轮更新')
    const disk = await (await agent.get(url)).json()
    expect(disk.content).toBe('第二轮更新\n合并新增行\n')
    expect(disk.revision).toBe(secondRevision)
    expect(writes).toEqual([])
  } finally { await agent.dispose() }
})

test('等待后仅剩接受和回滚，后续变化不重启倒计时且回滚恢复首轮之前正文', async ({ page, playwright }) => {
  await page.clock.setFixedTime(new Date())
  const before = '首轮之前的完整正文\n保留尾行\n'
  const { agent, url, revision } = await prepare(page, playwright, before)
  try {
    const editor = page.getByRole('textbox', { name: '源码编辑器' })
    await expect(editor).toContainText('首轮之前的完整正文')
    const writes = contentWrites(page)
    const first = await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: '第一轮正文\n' } })
    expect(first.status()).toBe(200)
    await expect(editor).toContainText('第一轮正文', { timeout: 4000 })
    const notice = page.locator('.remote-notice')
    await notice.getByRole('button', { name: '等待', exact: true }).click()
    await expect(notice.getByRole('button')).toHaveText(['接受', '回滚'])
    await advanceNoticeTime(page, 20000)
    await expect(notice.getByRole('button', { name: '接受', exact: true })).toBeVisible()
    await expect(page.locator('.external-gutter-mark.external-modified')).toHaveCount(1)
    const second = await agent.put(url, { headers: { 'If-Match': `"${(await first.json()).revision}"` }, data: { content: '等待期间第二轮正文\n' } })
    expect(second.status()).toBe(200)
    const latestRevision = (await second.json()).revision
    await expect(editor).toContainText('等待期间第二轮正文', { timeout: 4000 })
    await expect(notice).toHaveCount(1)
    await expect(notice.getByRole('button')).toHaveText(['接受', '回滚'])
    await advanceNoticeTime(page, 20000)
    await expect(notice.getByRole('button', { name: '回滚', exact: true })).toBeVisible()
    await expect(page.locator('.external-gutter-mark.external-modified')).toHaveCount(1)
    expect(writes).toEqual([])
    await notice.getByRole('button', { name: '回滚', exact: true }).click()
    await expect(notice).toHaveCount(0)
    await expect(editor).toContainText('首轮之前的完整正文')
    await expect(editor).not.toContainText('第一轮正文')
    expect((await (await agent.get(url)).json()).content).toBe(before)
    expect(writes).toEqual([{ method: 'PUT', match: `"${latestRevision}"`, content: { content: before, encoding: 'utf-8' } }])
  } finally { await agent.dispose() }
})

test('回滚在请求提交前遇到后续并发版本时返回 412，保留通知和最新磁盘正文', async ({ page, playwright }) => {
  const { agent, url, revision } = await prepare(page, playwright, '回滚基准正文\n')
  try {
    const editor = page.getByRole('textbox', { name: '源码编辑器' })
    await expect(editor).toContainText('回滚基准正文')
    const first = await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: '已显示的远程正文\n' } })
    expect(first.status()).toBe(200)
    const firstRevision = (await first.json()).revision
    await expect(editor).toContainText('已显示的远程正文', { timeout: 4000 })
    const notice = page.locator('.remote-notice')
    await notice.getByRole('button', { name: '等待', exact: true }).click()
    const writes = contentWrites(page)
    // 在真正的浏览器条件写之前提交另一真实 API 写入，不伪造 412 响应。
    await page.route('**/api/v1/files/content?*', async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return }
      expect(route.request().headers()['if-match']).toBe(`"${firstRevision}"`)
      expect((await agent.put(url, { headers: { 'If-Match': `"${firstRevision}"` }, data: { content: '后续并发正文必须保留\n' } })).status()).toBe(200)
      await route.continue()
    })
    const rejected = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/files/content?') && response.status() === 412)
    await notice.getByRole('button', { name: '回滚', exact: true }).click()
    await rejected
    await expect(notice.getByRole('alert')).toContainText('回滚未确认成功')
    await expect(notice.getByRole('button', { name: '回滚', exact: true })).toBeEnabled()
    await expect(editor).not.toContainText('回滚基准正文')
    expect((await (await agent.get(url)).json()).content).toBe('后续并发正文必须保留\n')
    expect(writes).toHaveLength(1)
  } finally { await page.unroute('**/api/v1/files/content?*'); await agent.dispose() }
})

test('通知倒计时期间本地输入暂停接受，后续远程变化和接受操作均不覆盖草稿', async ({ page, playwright }) => {
  await page.clock.setFixedTime(new Date())
  const { agent, url, revision } = await prepare(page, playwright, '初始正文\n')
  try {
    const editor = page.getByRole('textbox', { name: '源码编辑器' })
    await expect(editor).toContainText('初始正文')
    const first = await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: '第一轮远程正文\n' } })
    expect(first.status()).toBe(200)
    await expect(editor).toContainText('第一轮远程正文', { timeout: 4000 })
    const notice = page.locator('.remote-notice')
    const writes = contentWrites(page)
    await editor.fill('通知期间新输入的本地草稿')
    await expect(page.locator('.external-gutter-mark')).toHaveCount(0)
    await expect(page.getByRole('region', { name: '外部修改详情', exact: true })).toHaveCount(0)
    await expect(notice.getByRole('button', { name: '接受', exact: true })).toBeVisible()
    await expect(notice.getByRole('button', { name: '等待', exact: true })).toHaveCount(0)
    expect((await agent.put(url, { headers: { 'If-Match': `"${(await first.json()).revision}"` }, data: { content: '第二轮远程正文\n' } })).status()).toBe(200)
    await expect(page.locator('.save-status')).toContainText('版本冲突')
    await expect(editor).toHaveText('通知期间新输入的本地草稿')
    await advanceNoticeTime(page, 20000)
    await expect(notice.getByRole('button', { name: '接受', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(writes).toEqual([])
    await notice.getByRole('button', { name: '接受', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '文件版本发生冲突' })
    await expect(dialog.getByLabel('本地草稿', { exact: true })).toHaveValue('通知期间新输入的本地草稿')
    await expect(dialog.getByLabel('磁盘版本', { exact: true })).toHaveValue('第二轮远程正文\n')
    expect((await (await agent.get(url)).json()).content).toBe('第二轮远程正文\n')
    expect(writes).toEqual([])
  } finally { await agent.dispose() }
})

test('富文本按块提示三类变化，不安全转换退回源码保留原文', async ({ page, playwright }) => {
  const old = '# 标题\n\n第一段。\n\n保留段。\n\n待删段。\n\n末段。\n'
  const next = '# 标题\n\n修改段。\n\n新增段。\n\n保留段。\n\n末段。\n'
  const { agent, url, revision } = await prepare(page, playwright, old, 'md')
  try {
    await expect(page.locator('.rich-host .ProseMirror')).toContainText('第一段')
    expect((await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: next } })).status()).toBe(200)
    await expect(page.locator('.rich-host .ProseMirror')).toContainText('新增段', { timeout: 4000 })
    await expect(page.locator('.external-rich-modified')).toHaveCount(1)
    await expect(page.locator('.external-rich-inserted')).toHaveCount(1)
    await expect(page.locator('.external-rich-deleted-before')).toHaveCount(1)
    await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/rich-dark.png` })
    const current = await (await agent.get(url)).json()
    const unsafe = '---\ntitle: 必须保留的元数据\n---\n\n# 新正文\n'
    expect((await agent.put(url, { headers: { 'If-Match': `"${current.revision}"` }, data: { content: unsafe } })).status()).toBe(200)
    await expect(page.getByRole('textbox', { name: '源码编辑器' })).toContainText('必须保留的元数据', { timeout: 5000 })
    await expect(page.getByText(/外部更新的 Markdown 需要转换/)).toBeVisible()
    expect((await (await agent.get(url)).json()).content).toBe(unsafe)
  } finally { await agent.dispose() }
})

test('接收更新读取期间继续输入，拒绝迟到正文覆盖', async ({ page, playwright }) => {
  const { agent, url, revision } = await prepare(page, playwright, '旧正文\n')
  try {
    const editor = page.getByRole('textbox', { name: '源码编辑器' })
    await expect(editor).toContainText('旧正文')
    let received!: () => void, release!: () => void
    const reading = new Promise<void>(resolve => { received = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    await page.route('**/api/v1/files/content?*', async route => {
      if (route.request().method() !== 'GET') { await route.continue(); return }
      const response = await route.fetch(); received(); await blocked; await route.fulfill({ response })
    })
    expect((await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: '远端新正文\n' } })).status()).toBe(200)
    await reading
    await editor.fill('读取期间输入的草稿')
    release()
    await expect(page.locator('.save-status')).toContainText('版本冲突')
    await expect(editor).toHaveText('读取期间输入的草稿')
    await page.unroute('**/api/v1/files/content?*')
    expect((await (await agent.get(url)).json()).content).toBe('远端新正文\n')
  } finally { await agent.dispose() }
})

for (const mode of ['source', 'rich'] as const) {
  for (const decision of ['wait', 'automatic'] as const) {
    test(`${mode === 'source' ? '源码' : '富文本'}标记和展开详情${decision === 'wait' ? '等待 20 秒后保留，接受立即清除' : '随 10 秒自动接受清除'}`, async ({ page, playwright }) => {
      await page.clock.setFixedTime(new Date())
      const before = mode === 'source' ? '首行\n旧正文\n末行\n' : '# 标题\n\n旧正文\n\n末段\n'
      const after = before.replace('旧正文', '远程新正文')
      const { agent, url, revision } = await prepare(page, playwright, before, mode === 'source' ? 'txt' : 'md')
      try {
        const editor = page.locator(mode === 'source' ? '.cm-content' : '.rich-host .ProseMirror')
        await expect(editor).toContainText('旧正文')
        const writes = contentWrites(page)
        const response = await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: after } })
        expect(response.status()).toBe(200)
        const savedRevision = (await response.json()).revision
        await expect(editor).toContainText('远程新正文', { timeout: 4000 })
        const notice = page.locator('.remote-notice')
        const marks = page.locator(mode === 'source' ? '.external-gutter-mark' : '.external-rich-change-button')
        const modified = mode === 'source'
          ? page.locator('.external-gutter-mark.external-modified[role="button"]')
          : page.getByRole('button', { name: '查看外部修改详情', exact: true })
        const peek = page.getByRole('region', { name: '外部修改详情', exact: true })
        await expect(modified).toHaveCount(1)
        if (decision === 'wait') await notice.getByRole('button', { name: '等待', exact: true }).click()
        await modified.click()
        await expect(peek).toBeVisible()
        await advanceNoticeTime(page, decision === 'wait' ? 20000 : 9000)
        await expect(notice.getByRole('button', { name: decision === 'wait' ? '接受' : '接受（1s）', exact: true })).toBeVisible()
        await expect(modified).toHaveCount(1)
        await expect(peek).toBeVisible()
        if (decision === 'wait') {
          await notice.getByRole('button', { name: '接受', exact: true }).click()
        } else {
          await advanceNoticeTime(page, 1000)
        }
        await expect(notice).toHaveCount(0)
        await expect(marks).toHaveCount(0)
        await expect(peek).toHaveCount(0)
        await expect(editor).toContainText('远程新正文')
        expect(writes).toEqual([])
        const disk = await (await agent.get(url)).json()
        expect(disk.content).toBe(after)
        expect(disk.revision).toBe(savedRevision)
      } finally { await agent.dispose() }
    })
  }
  test(`${mode === 'source' ? '源码' : '富文本'}替换伴随末尾删除时，红三角展开完整旧内容`, async ({ page, playwright }) => {
    const before = mode === 'source' ? '替换之前\n被删除的末尾\n' : '替换之前\n\n被删除的末尾\n'
    const after = '替换之后\n'
    const { agent, url, revision } = await prepare(page, playwright, before, mode === 'source' ? 'txt' : 'md')
    try {
      await expect(mode === 'source' ? page.locator('.cm-content') : page.locator('.rich-host .ProseMirror')).toContainText('被删除的末尾')
      const writes = contentWrites(page)
      expect((await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: after } })).status()).toBe(200)
      const deleted = mode === 'source' ? page.locator('.external-gutter-mark.external-deleted.external-after') : page.locator('.external-rich-change-button-deleted.external-rich-change-button-after')
      await expect(deleted).toHaveCount(1)
      await deleted.click()
      const peek = page.getByRole('region', { name: '外部修改详情', exact: true })
      await expect(peek.getByLabel('修改前', { exact: true })).toContainText('替换之前')
      await expect(peek.getByLabel('修改前', { exact: true })).toContainText('被删除的末尾')
      await expect(peek.getByLabel('修改后', { exact: true })).toContainText('替换之后')
      expect(writes).toEqual([])
      expect((await (await agent.get(url)).json()).content).toBe(after)
    } finally { await agent.dispose() }
  })
  for (const width of [1440, 390]) {
    test(`${mode === 'source' ? '源码' : '富文本'}内联详情支持展开、收起和键盘且不改正文（${width}px）`, async ({ page, playwright }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.clock.setFixedTime(new Date())
      const before = mode === 'source'
        ? '共同首行\n修改前的独立内容\n共同中行\n删除前的独立内容\n共同末行\n'
        : '# 内联详情\n\n修改前的独立内容\n\n共同中段\n\n删除前的独立内容\n\n共同末段\n'
      const after = mode === 'source'
        ? '共同首行\n修改后的最新内容\n共同中行\n共同末行\n'
        : '# 内联详情\n\n修改后的最新内容\n\n共同中段\n\n共同末段\n'
      const { agent, url, revision } = await prepare(page, playwright, before, mode === 'source' ? 'txt' : 'md')
      try {
        const editor = mode === 'source' ? page.locator('.cm-content') : page.locator('.rich-host .ProseMirror')
        await expect(editor).toContainText('修改前的独立内容')
        const closeDrawer = page.getByRole('button', { name: '关闭文件列表', exact: true })
        if (await closeDrawer.isVisible()) await closeDrawer.click()
        const writes = contentWrites(page)
        const response = await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: after } })
        expect(response.status()).toBe(200)
        const savedRevision = (await response.json()).revision
        const modified = mode === 'source'
          ? page.locator('.external-gutter-mark.external-modified[role="button"]')
          : page.getByRole('button', { name: '查看外部修改详情', exact: true })
        const deleted = mode === 'source'
          ? page.locator('.external-gutter-mark.external-deleted[role="button"]')
          : page.getByRole('button', { name: /^查看外部删除详情/ })
        await expect(modified).toHaveCount(1)
        await expect(deleted).toHaveCount(1)
        await page.locator('.remote-notice').getByRole('button', { name: '等待', exact: true }).click()
        await expect(editor).toContainText('修改后的最新内容')
        await expect(editor).not.toContainText('修改前的独立内容')
        await expect(editor).not.toContainText('删除前的独立内容')
        const bodyText = () => editor.evaluate(element => {
          const copy = element.cloneNode(true) as HTMLElement
          copy.querySelectorAll('.external-change-peek, .external-rich-change-button').forEach(node => node.remove())
          return copy.textContent
        })
        const latestBody = await bodyText()
        const peek = page.getByRole('region', { name: '外部修改详情', exact: true })
        await modified.click()
        await expect(modified).toHaveAttribute('aria-expanded', 'true')
        await expect(peek).toHaveCount(1)
        await expect(editor.locator('.external-change-peek')).toHaveCount(1)
        await expect(peek.locator('pre[aria-label="修改前"]')).toContainText('修改前的独立内容')
        await expect(peek.locator('pre[aria-label="修改后"]')).toContainText('修改后的最新内容')
        await expect(peek.locator('.external-change-peek-heading, .external-change-peek-label, strong')).toHaveCount(0)
        const previousBox = await peek.getByLabel('修改前', { exact: true }).boundingBox()
        const currentBox = await peek.getByLabel('修改后', { exact: true }).boundingBox()
        expect(previousBox).not.toBeNull(); expect(currentBox).not.toBeNull()
        expect(Math.abs(previousBox!.y + previousBox!.height - currentBox!.y)).toBeLessThan(1)
        await expect(peek).not.toContainText('删除前的独立内容')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        expect(await bodyText()).toBe(latestBody)
        await peek.getByRole('button', { name: '收起', exact: true }).click()
        await expect(peek).toHaveCount(0)
        await expect(modified).toHaveAttribute('aria-expanded', 'false')
        await modified.click()
        await expect(peek).toBeVisible()
        await modified.click()
        await expect(peek).toHaveCount(0)
        await modified.focus()
        await page.keyboard.press('Enter')
        await expect(peek).toBeVisible()
        await peek.locator('pre[aria-label="修改前"]').focus()
        await page.keyboard.press('Escape')
        await expect(peek).toHaveCount(0)
        await expect(modified).toHaveAttribute('aria-expanded', 'false')
        await deleted.focus()
        await page.keyboard.press('Space')
        await expect(deleted).toHaveAttribute('aria-expanded', 'true')
        await expect(peek.locator('pre[aria-label="修改前"]')).toContainText('删除前的独立内容')
        await expect(peek.locator('pre[aria-label="修改后"]')).toHaveCount(0)
        await expect(peek).not.toContainText('修改前的独立内容')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        expect(await bodyText()).toBe(latestBody)
        await deleted.press('Escape')
        await expect(peek).toHaveCount(0)
        await modified.click()
        await expect(peek).toBeVisible()
        await mkdir(output, { recursive: true })
        for (const theme of ['light', 'dark']) {
          await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme)
          await expect(peek).toBeVisible()
          if (mode === 'source') {
            const line = await editor.locator('.cm-line').filter({ hasText: '共同中行' }).boundingBox()
            const number = await page.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: /^3$/ }).boundingBox()
            expect(line).not.toBeNull(); expect(number).not.toBeNull()
            expect(Math.abs(line!.y - number!.y)).toBeLessThan(4)
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: `${output}/peek-${mode}-${width}-${theme}.png`, animations: 'disabled', caret: 'hide' })
        }
        await advanceNoticeTime(page, 20000)
        await expect(peek).toBeVisible()
        await peek.getByRole('button', { name: '收起', exact: true }).click()
        await expect(peek).toHaveCount(0)
        await expect(modified).toHaveCount(1)
        await expect(deleted).toHaveCount(1)
        await modified.click()
        await expect(peek).toBeVisible()
        await page.locator('.remote-notice').getByRole('button', { name: '接受', exact: true }).click()
        await expect(page.locator('.remote-notice')).toHaveCount(0)
        await expect(peek).toHaveCount(0)
        await expect(page.locator(mode === 'source' ? '.external-gutter-mark' : '.external-rich-change-button')).toHaveCount(0)
        expect(await bodyText()).toBe(latestBody)
        await expect(page.getByRole('dialog')).toHaveCount(0)
        expect(writes).toEqual([])
        const disk = await (await agent.get(url)).json()
        expect(disk.content).toBe(after)
        expect(disk.revision).toBe(savedRevision)
      } finally { await agent.dispose() }
    })
  }
}
