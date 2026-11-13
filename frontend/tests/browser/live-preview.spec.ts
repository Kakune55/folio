import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function prepare(page: Page, source: string) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  const connected = page.waitForResponse(response => response.url().includes('/workspace/events?') && response.status() === 200)
  await page.getByRole('button', { name: '进入工作区' }).click(); await connected
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const path = `实时预览-${Date.now()}-${test.info().testId.slice(-8)}.md`
  const created = await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': me.csrfToken }, data: { path, content: source } })
  expect(created.status()).toBe(201)
  const revision = (await created.json()).revision as string
  const writes: { content: string; match?: string }[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/v1/files/content' && ['PUT', 'PATCH'].includes(request.method())) writes.push({ content: request.postDataJSON().content, match: request.headers()['if-match'] })
  })
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name: path, exact: true }).click()
  const editor = page.locator('.source-host .cm-content')
  await expect(editor).toHaveAttribute('aria-label', 'Markdown 编辑器')
  const read = async () => {
    const response = await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)
    expect(response.status()).toBe(200)
    const disk = await response.json()
    expect(response.headers().etag).toBe(`"${disk.revision}"`)
    return { content: disk.content as string, revision: disk.revision as string }
  }
  return { path, editor, revision, writes, read }
}

async function paste(page: Page, text: string) {
  // 合成事件验证应用处理器，不代表真实 OS 剪贴板。
  await page.locator('.cm-content').evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, text)
}

test('非活动装饰、焦点和主题变化不产生正文写入', async ({ page }) => {
  const source = '# 标题\n\n**强调** 与 `代码`\n\n- [ ] 任务\n\n光标行\n'
  const { editor, revision, writes, read } = await prepare(page, source)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End')
  await expect(editor.locator('.folio-md-strong')).toContainText('强调')
  await expect(editor.getByRole('checkbox')).toHaveCount(1)
  for (const theme of ['dark', 'light']) await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
  await editor.blur(); await editor.focus()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.waitForTimeout(1100)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('活动行显示标记，切模式共用 DOM、选区与撤销记录', async ({ page }) => {
  const { editor, writes, read } = await prepare(page, '**强调**\n\n尾行')
  await editor.focus(); await page.keyboard.press('ControlOrMeta+Home')
  await expect(editor.locator('.cm-line').first()).toContainText('**强调**')
  await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('新增')
  await expect.poll(async () => (await read()).content).toBe('**强调**\n\n尾行新增')
  await page.keyboard.press('Shift+ArrowLeft')
  const node = await editor.elementHandle()
  for (const mode of ['源码', '实时预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click()
    expect(await editor.evaluate((element, node) => element === node, node)).toBe(true)
    await editor.focus()
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('增')
  }
  expect(writes).toHaveLength(1)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await read()).content).toBe('**强调**\n\n尾行')
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect.poll(async () => (await read()).content).toBe('**强调**\n\n尾行新增')
})

test('引用定义和 code meta 粘贴精确插入，不发生准入转换', async ({ page }) => {
  const source = '\uFEFF首行\r\n'
  const pasted = '[unused]: /keep "保留"\n\n~~~js filename="keep.js"\rconst a = 1\r\n~~~'
  const { editor, revision, writes, read } = await prepare(page, source)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End'); await paste(page, pasted)
  await expect.poll(async () => (await read()).content).toBe(source + pasted)
  await expect.poll(() => writes.length).toBe(1)
  expect(writes).toEqual([{ content: source + pasted, match: `"${revision}"` }])
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('任务框仅修改一个字符，BOM、混合换行与 ETag 保留', async ({ page }) => {
  const source = '\uFEFF# 标题\r\n\r\n* [ ] 原始任务  \n\r尾行'
  const { editor, revision, writes, read } = await prepare(page, source)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End')
  await editor.getByRole('checkbox', { name: '标记为已完成' }).click()
  const expected = source.replace('[ ]', '[x]')
  await expect.poll(async () => (await read()).content).toBe(expected)
  expect(writes).toEqual([{ content: expected, match: `"${revision}"` }])
  await editor.focus(); await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await read()).content).toBe(source)
})

test('表格单元格点击只定位原文选区，不重序列化或保存', async ({ page }) => {
  const source = '# 表格\n\n| 左 | 右 |\n| :---- | ----: |\n| 一 | 二 |\n\n尾行'
  const { editor, revision, writes, read } = await prepare(page, source)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End')
  const cell = page.locator('.folio-preview-table td').filter({ hasText: /^二$/ })
  await expect(cell).toBeVisible(); await cell.click()
  await expect(editor.locator('.cm-line').filter({ hasText: '| 一 | 二 |' })).toBeVisible()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('二')
  await page.waitForTimeout(1100)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('选中文字粘贴URL仍按原始文本替换，不自动改造成Markdown链接', async ({ page }) => {
  const { editor, read } = await prepare(page, 'prefix target suffix\n')
  await editor.focus(); await page.keyboard.press('ControlOrMeta+Home')
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('target')
  const url = 'https://example.invalid/p?q=1&x=2'
  await paste(page, url)
  await expect.poll(async () => (await read()).content).toBe(`prefix ${url} suffix\n`)
})

test('源码模式移除所有实时预览装饰与资源 widget，正文零写入', async ({ page }) => {
  const source = '# 标题\n\n**正文**\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n尾行'
  const { editor, revision, writes, read } = await prepare(page, source)
  await expect(page.locator('.mermaid-preview')).toHaveCount(1)
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(editor).toHaveAttribute('aria-label', '源码编辑器')
  await expect(page.locator('.folio-md-strong, .folio-md-task, .mermaid-preview, .folio-preview-table')).toHaveCount(0)
  await page.waitForTimeout(1100)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('锁定文件时粘贴与任务框不能隐藏写入，失败后保留原文', async ({ page }) => {
  const source = '# 标题\n\n- [ ] 任务\n\n尾行'
  const { path, editor, revision, writes, read } = await prepare(page, source)
  const destination = `移动目标-${path}`
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  expect((await page.request.post('/api/v1/directories', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path: destination } })).status()).toBe(201)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End')
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/v1/entries/move', async route => {
    entered(); await gate
    await route.fulfill({ status: 503, json: { error: { code: 'test_locked', message: '测试移动中断，原文保留' } } })
  })
  await page.getByRole('button', { name: `文件操作 ${path}`, exact: true }).click()
  await page.getByRole('menuitem', { name: '移动到…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '移动到', exact: true })
  await dialog.getByRole('button', { name: `进入目录 ${destination}`, exact: true }).click()
  await dialog.getByRole('button', { name: '移动到此', exact: true }).click()
  await started
  try {
    await expect(editor).toHaveAttribute('contenteditable', 'false')
    await paste(page, '不应插入的隐藏文字')
    // 合成点击覆盖已显示任务框在锁定后仍收到旧事件的边界。
    await editor.getByRole('checkbox', { includeHidden: true }).evaluate(element => (element as HTMLElement).click())
    await page.waitForTimeout(1100)
    expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
  } finally { release() }
  await expect(dialog.getByRole('alert')).toContainText('测试移动中断，原文保留')
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  expect((await read()).content).toBe(source)
})

test('长文档视口仿真只渲染有界 DOM，首尾导航不写入', async ({ page }) => {
  const source = Array.from({ length: 1800 }, (_, index) => `第 ${index} 行 **保留原文**`).join('\n')
  const { editor, revision, writes, read } = await prepare(page, source)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End')
  await expect(editor.locator('.cm-line').last()).toContainText('第 1799 行')
  expect(await editor.locator('.cm-line').count()).toBeLessThan(1800)
  await page.keyboard.press('ControlOrMeta+Home')
  await expect(editor.locator('.cm-line').first()).toContainText('第 0 行')
  await page.waitForTimeout(1100)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('IME 合成事件仿真冻结装饰且不触发正文写入，非真实输入法验收', async ({ page }) => {
  const source = '# 标题\n\n**组合文字**\n\n尾行'
  const { editor, revision, writes, read } = await prepare(page, source)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End')
  await editor.dispatchEvent('compositionstart', { data: '' })
  await editor.dispatchEvent('keydown', { key: 'p', ctrlKey: true, isComposing: true })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Home')
  await editor.dispatchEvent('compositionupdate', { data: '中文候选' })
  await editor.dispatchEvent('compositionend', { data: '' })
  await expect(editor.locator('.cm-line').first()).toContainText('# 标题')
  await page.waitForTimeout(1100)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('HTML 原文不执行脚本、不加载外部资源且查看不回写', async ({ page }) => {
  const source = '<img src="https://evil.test/private.png" onerror="window.rawExecuted=true">\n\n<script>window.rawExecuted=true</script>\n'
  const external: string[] = []
  page.on('request', request => { if (request.url().startsWith('https://evil.test/')) external.push(request.url()) })
  const { revision, writes, read } = await prepare(page, source)
  await page.waitForTimeout(1100)
  expect(await page.evaluate(() => 'rawExecuted' in window)).toBe(false)
  expect(external).toEqual([])
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('格式工具条只改选中文字，保留BOM换行并可撤销后插入链接', async ({ page }) => {
  const source = '\ufeff# 顶\r\n\r\n甲 target 乙\r\n'
  const { editor, read } = await prepare(page, source)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('target')
  await page.getByRole('button', { name: '加粗', exact: true }).click()
  await expect.poll(async () => (await read()).content).toBe(source.replace('target', '**target**'))
  await editor.focus(); await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await read()).content).toBe(source)
  await page.getByRole('button', { name: '插入链接', exact: true }).click()
  await page.keyboard.insertText('目标.md')
  await expect.poll(async () => (await read()).content).toBe(source.replace('target', '[target](目标.md)'))
})

for (const confirm of [true, false]) test(`Chromium原生IME候选暂停自动保存，${confirm ? '确认后保存中文' : '取消后原文版本不变'}`, async ({ page }) => {
  const source = '\ufeff- [ ] 待办\r\n\r\n正文。\r\n'
  const { editor, read, writes, revision } = await prepare(page, source)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End')
  const protocol = await page.context().newCDPSession(page)
  try {
    // 协议注入走 Chromium 原生 composition，仍不代表真实 OS 输入法候选栏验收。
    await protocol.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
    await expect(page.locator('.save-status')).toContainText('输入法候选待确认')
    await expect(page.getByRole('button', { name: '加粗', exact: true })).toBeDisabled()
    // 强制调用控件回调验证状态重查，不声称候选期间原生鼠标交互已实测。
    await page.getByRole('checkbox').evaluate(element => (element as HTMLElement).click())
    await page.waitForTimeout(1200)
    expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
    if (confirm) {
      await protocol.send('Input.insertText', { text: '中文' })
      await expect.poll(async () => (await read()).content).toBe(source + '中文')
      await expect.poll(() => writes.length).toBe(1)
      expect(writes[0]).toEqual({ content: source + '中文', match: `"${revision}"` })
    } else {
      await protocol.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
      await expect(page.locator('.save-status')).toHaveText('已保存')
      expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
    }
  } finally { await protocol.detach().catch(() => {}) }
})

test('图片重试成功遇到原生IME候选，不重建编辑器或偷偷保存候选和引用', async ({ page }) => {
  const source = '原文'
  const { editor, read, writes, revision } = await prepare(page, source)
  await page.route('**/api/v1/uploads?**', route => route.fulfill({ status: 500, json: { error: { code: 'test_failure', message: '上传失败测试' } } }))
  const png = [...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9r8AAAAASUVORK5CYII=', 'base64')]
  await editor.evaluate((element, bytes) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], '候选.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, png)
  await expect(page.locator('.upload-failure')).toContainText('上传失败测试')
  await page.unroute('**/api/v1/uploads?**')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/v1/uploads?**', async route => { await gate; await route.continue().catch(() => {}) })
  const started = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/uploads')
  await page.getByRole('button', { name: '重试到当前目录' }).click(); await started
  const node = await editor.elementHandle()
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End')
  const protocol = await page.context().newCDPSession(page)
  try {
    await protocol.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
    await expect(page.locator('.save-status')).toContainText('输入法候选待确认')
    const uploaded = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/uploads')
    release()
    const response = await uploaded; expect(response.status()).toBe(201)
    const metadata = await response.json()
    await expect(page.locator('.upload-failure')).toHaveCount(0)
    await expect(page.locator('.notice').filter({ hasText: '未确认' })).toBeVisible()
    expect(await node!.evaluate(element => element.isConnected)).toBe(true)
    await page.waitForTimeout(1200)
    expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
    expect((await page.request.get(`/api/v1/files/metadata?path=${encodeURIComponent(metadata.path)}`)).status()).toBe(200)
    await protocol.send('Input.insertText', { text: '中文' })
    await expect.poll(async () => (await read()).content).toBe(source + '中文')
    expect((await read()).content).not.toContain('![')
  } finally { release(); await protocol.detach().catch(() => {}) }
})
