import { expect, test } from '@playwright/test'
import type { Page, Playwright } from '@playwright/test'

const editor = (page: Page) => page.locator('.source-host .cm-content')

async function prepare(page: Page, playwright: Playwright, source: string) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  const connected = page.waitForResponse(response => response.url().includes('/workspace/events?') && response.status() === 200)
  await page.getByRole('button', { name: '进入工作区' }).click(); await connected
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const headers = { 'X-CSRF-Token': me.csrfToken }
  const path = `保源-${Date.now()}-${test.info().testId.slice(-8)}.md`
  const created = await page.request.post('/api/v1/files', { headers, data: { path, content: source } })
  expect(created.status()).toBe(201)
  const revision: string = (await created.json()).revision
  const token = await (await page.request.post('/api/v1/user/tokens', { headers, data: { name: '保源验收', permissions: { files: 'write', search: 'none', trash: 'none' }, expiresAt: 0 } })).json()
  const agent = await playwright.request.newContext({ baseURL: new URL(page.url()).origin, extraHTTPHeaders: { Authorization: `Bearer ${token.token}` } })
  const url = `/api/v1/files/content?path=${encodeURIComponent(path)}`
  const writes: { content: string; match: string | undefined }[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/v1/files/content' && ['PUT', 'PATCH'].includes(request.method())) writes.push({ content: request.postDataJSON().content, match: request.headers()['if-match'] })
  })
  await page.getByRole('button', { name: path, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true })).toBeVisible()
  const read = async () => {
    const response = await agent.get(url)
    expect(response.status()).toBe(200)
    const disk = await response.json()
    expect(response.headers().etag).toBe(`"${disk.revision}"`)
    return { content: disk.content as string, revision: disk.revision as string }
  }
  return { agent, url, path, revision, writes, read }
}

async function append(page: Page, text = '新增') {
  await editor(page).locator('.cm-line').filter({ hasText: /^编辑目标。$/ }).click()
  await page.keyboard.press('End'); await page.keyboard.insertText(text)
}

const formatted = '保留标题\n========\n\n\n\n| 左 | 右 |\n| :---- | ----: |\n| 一 | 二 |\n\n\n~~~json\n{"keep":true}\n~~~\n\n`````text\n```不能闭合长围栏\n`````\n\n* 统一一\n* 统一二\n\n+ 不同顶层\n\n\n编辑目标。\n\n\n保留尾段。'

test('空文件逐键输入空格原样保存，撤销、重做与刷新不编码空白', async ({ page, playwright }) => {
  const { agent, path, read } = await prepare(page, playwright, '')
  try {
    await editor(page).focus(); await page.keyboard.press('Space'); await page.keyboard.press('Space')
    await expect.poll(async () => (await read()).content).toBe('  ')
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await read()).content).toBe('')
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect.poll(async () => (await read()).content).toBe('  ')
    await page.keyboard.insertText('正文  ')
    await expect.poll(async () => (await read()).content).toBe('  正文  ')
    await page.reload(); await page.getByRole('button', { name: path, exact: true }).click()
    expect((await read()).content).toBe('  正文  ')
  } finally { await agent.dispose() }
})

test('连续空格及纯空白行仅改变目标行，模式切换保留 CRLF', async ({ page, playwright }) => {
  const prefix = '保留标题\r\n========\r\n\r\n'
  const { agent, read } = await prepare(page, playwright, `${prefix}编辑目标。`)
  try {
    await append(page, '  ')
    await expect.poll(async () => (await read()).content).toBe(`${prefix}编辑目标。  `)
    await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await page.keyboard.insertText('   ')
    await expect.poll(async () => (await read()).content).toBe(`${prefix}   `)
    for (const mode of ['源码', '实时预览']) await page.getByRole('button', { name: mode, exact: true }).click()
    expect((await read()).content).toBe(`${prefix}   `)
  } finally { await agent.dispose() }
})

for (const [name, source] of [
  ['LF 多空行、表格、setext、围栏与列表', formatted],
  ['BOM、CRLF 与无末尾换行', `\uFEFF${formatted.replaceAll('\n', '\r\n')}`],
  ['frontmatter', '---\ntitle: 保留元数据\n---\n\n编辑目标。\n'],
  ['未使用引用定义', '[unused]: https://example.invalid/ "不能丢弃"\n\n编辑目标。\n'],
  ['code info meta', '~~~json filename="keep.json"\n{"keep":true}\n~~~\n\n编辑目标。\n'],
] as const) test(`保源 ${name}：查看与模式切换零写入，编辑只改目标原文`, async ({ page, playwright }) => {
  const { agent, path, revision, writes, read } = await prepare(page, playwright, source)
  try {
    await editor(page).focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight')
    for (const mode of ['源码', '实时预览']) await page.getByRole('button', { name: mode, exact: true }).click()
    await page.reload(); await page.getByRole('button', { name: path, exact: true }).click()
    await expect(editor(page)).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(1100)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
    await append(page)
    const expected = source.replace('编辑目标。', '编辑目标。新增')
    await expect.poll(async () => (await read()).content).toBe(expected)
    expect(writes).toEqual([{ content: expected, match: `"${revision}"` }])
  } finally { await agent.dispose() }
})

test('撤销恢复完整初始 source，重做继续使用最新 ETag 条件保存', async ({ page, playwright }) => {
  const { agent, revision, writes, read } = await prepare(page, playwright, formatted)
  try {
    await append(page)
    const edited = formatted.replace('编辑目标。', '编辑目标。新增')
    await expect.poll(async () => (await read()).content).toBe(edited)
    const saved = await read()
    await page.getByRole('button', { name: '源码', exact: true }).click(); await editor(page).focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await read()).content).toBe(formatted)
    const undone = await read()
    await page.getByRole('button', { name: '实时预览', exact: true }).click(); await editor(page).focus()
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect.poll(async () => (await read()).content).toBe(edited)
    expect(writes).toEqual([{ content: edited, match: `"${revision}"` }, { content: formatted, match: `"${saved.revision}"` }, { content: edited, match: `"${undone.revision}"` }])
  } finally { await agent.dispose() }
})

test('SSE 更新不回写，接续编辑使用远端 ETag 并拒绝旧版本覆盖', async ({ page, playwright }) => {
  const { agent, url, revision, writes, read } = await prepare(page, playwright, formatted)
  try {
    const remote = formatted.replace('保留尾段。', '远程尾段。')
    const response = await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: remote } })
    expect(response.status()).toBe(200)
    const remoteRevision = (await response.json()).revision
    await expect(editor(page)).toContainText('远程尾段。')
    await page.locator('.remote-notice').getByRole('button', { name: '等待', exact: true }).click()
    await expect(page.locator('.source-host')).toHaveAttribute('data-mode', 'rich')
    await page.waitForTimeout(1100)
    expect(await read()).toEqual({ content: remote, revision: remoteRevision }); expect(writes).toEqual([])
    await append(page)
    const expected = remote.replace('编辑目标。', '编辑目标。新增')
    await expect.poll(async () => (await read()).content).toBe(expected)
    expect(writes).toEqual([{ content: expected, match: `"${remoteRevision}"` }])
    expect((await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: '不应覆盖' } })).status()).toBe(412)
  } finally { await agent.dispose() }
})

for (const [name, pasted] of [
  ['空格和空白行', '  \n   \n正文  '],
  ['frontmatter', '---\ntitle: 粘贴元数据\n---\n'],
  ['引用定义', '粘贴正文。\n\n[keep]: /important "必须保留的定义"\n'],
  ['代码附加信息', '```js filename="important.js"\nconst keep = 1\n```\n'],
  ['BOM 和混合换行', '\uFEFF首行\r\n次行\r第三行\n末行'],
] as const) test(`纯文本粘贴 ${name} 原样插入保存并可撤销重做`, async ({ page, playwright }) => {
  const source = '原文。'
  const { agent, path, read, writes, revision } = await prepare(page, playwright, source)
  try {
    await editor(page).focus(); await page.keyboard.press('ControlOrMeta+End')
    // 合成事件覆盖应用粘贴处理，不冒称系统剪贴板验证。
    await editor(page).evaluate((root, text) => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text)
      root.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    }, pasted)
    await expect.poll(async () => (await read()).content).toBe(source + pasted)
    expect(writes[0]).toEqual({ content: source + pasted, match: `"${revision}"` })
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await read()).content).toBe(source)
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect.poll(async () => (await read()).content).toBe(source + pasted)
    await page.reload(); await page.getByRole('button', { name: path, exact: true }).click()
    await expect(editor(page)).toBeVisible()
    expect((await read()).content).toBe(source + pasted)
  } finally { await agent.dispose() }
})

for (const marker of ['~~~c++', '~~~~~c#', '`````shell-session', '```json', '～～～json', '｀｀｀json', '~~`json', '``~json', '- ', '1. ']) {
  test(`逐键输入 ${marker} 保留源码并遵循 Markdown 回车规则`, async ({ page, playwright }) => {
    const { agent, read, writes } = await prepare(page, playwright, '')
    try {
      await editor(page).focus(); await page.keyboard.type(marker)
      if (marker.endsWith(' ')) await expect.poll(async () => (await read()).content).toBe(marker)
      await page.keyboard.press('Enter'); await page.keyboard.insertText('saved_text_42')
      await expect.poll(async () => (await read()).content).toBe(marker.endsWith(' ') ? 'saved_text_42' : `${marker}\nsaved_text_42`)
      await expect(page.locator('.cm-editor')).toHaveCount(1)
      expect(writes.every(write => Boolean(write.match))).toBe(true)
    } finally { await agent.dispose() }
  })
}

for (const key of ['Enter', 'Shift+Enter']) for (const source of ['AB', '\uFEFFAB\r\n', '~~~js\nconst keep = 1\n~~~', '- 原有项\n- 第二项', '| 保留 |\n| --- |\n| 原文 |']) {
  test(`${key} 尾部连续换行无 BR artifact ${JSON.stringify(source)}`, async ({ page, playwright }) => {
    const { agent, path, read } = await prepare(page, playwright, source)
    try {
      const separator = source.includes('\r\n') ? '\r\n' : '\n'
      const steps = key === 'Enter' && source.startsWith('- ')
        ? [source + '\n- ', source + '\n', source + '\n\n']
        : [1, 2, 3].map(count => source + separator.repeat(count))
      await editor(page).focus(); await page.keyboard.press('ControlOrMeta+End')
      for (let i = 1; i <= 3; i++) {
        await page.keyboard.press(key)
        await expect.poll(async () => (await read()).content).toBe(steps[i - 1])
      }
      await page.keyboard.insertText('新增尾段。')
      const expected = steps[2] + '新增尾段。'
      await expect.poll(async () => (await read()).content).toBe(expected)
      expect(expected).not.toContain('<br')
      await page.keyboard.press('ControlOrMeta+z')
      await expect.poll(async () => (await read()).content).toBe(steps[2])
      await page.keyboard.press('ControlOrMeta+Shift+Z')
      await expect.poll(async () => (await read()).content).toBe(expected)
      await page.reload(); await page.getByRole('button', { name: path, exact: true }).click()
      expect((await read()).content).toBe(expected)
    } finally { await agent.dispose() }
  })
}

for (const key of ['Enter', 'Shift+Enter']) test(`段中 ${key} 仅插入原始换行并保留其他字节`, async ({ page, playwright }) => {
  const { agent, read } = await prepare(page, playwright, formatted)
  try {
    await editor(page).locator('.cm-line').filter({ hasText: /^编辑目标。$/ }).click()
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
    await page.keyboard.press(key)
    await expect.poll(async () => (await read()).content).toBe(formatted.replace('编辑目标。', '编辑\n目标。'))
  } finally { await agent.dispose() }
})
