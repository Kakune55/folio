import { expect, test } from '@playwright/test'
import type { Page, Playwright } from '@playwright/test'

const rich = (page: Page) => page.getByRole('textbox', { name: 'Markdown 富文本编辑器', exact: true })
const conversion = (page: Page) => page.getByRole('dialog', { name: '富文本转换预览' })

async function prepare(page: Page, playwright: Playwright, source: string) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  const connected = page.waitForResponse(response => response.url().includes('/workspace/events?') && response.status() === 200)
  await page.getByRole('button', { name: '进入工作区' }).click()
  await connected
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
    if (new URL(request.url()).pathname === '/api/v1/files/content' && ['PUT', 'PATCH'].includes(request.method())) {
      writes.push({ content: request.postDataJSON().content, match: request.headers()['if-match'] })
    }
  })
  await page.getByRole('button', { name: path, exact: true }).click()
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
  await rich(page).locator('p').filter({ hasText: /^编辑目标。$/ }).click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(text)
}

const formatted = '保留标题\n========\n\n\n\n| 左 | 右 |\n| :---- | ----: |\n| 一 | 二 |\n\n\n~~~json\n{"keep":true}\n~~~\n\n`````text\n```不能闭合长围栏\n`````\n\n* 统一一\n* 统一二\n\n+ 不同顶层\n\n\n编辑目标。\n\n\n保留尾段。'

for (const [name, source] of [
  ['LF 多空行、表格对齐、setext、原有围栏与列表', formatted],
  ['BOM、CRLF 与无末尾换行', `\uFEFF${formatted.replaceAll('\n', '\r\n')}`],
] as const) {
  test(`保源 ${name}：只读、刷新、焦点与模式往返无写入，编辑仅替换目标段`, async ({ page, playwright }) => {
    const { agent, path, revision, writes, read } = await prepare(page, playwright, source)
    try {
      await expect(rich(page)).toBeVisible()
      await expect(conversion(page)).toHaveCount(0)
      await rich(page).click()
      await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight')
      await page.getByRole('button', { name: '源码', exact: true }).click()
      await expect(page.getByRole('textbox', { name: '源码编辑器', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '富文本', exact: true }).click()
      await expect(rich(page)).toBeVisible()
      await page.reload()
      await page.getByRole('button', { name: path, exact: true }).click()
      await expect(rich(page)).toBeVisible()
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.waitForTimeout(1100)
      await expect(conversion(page)).toHaveCount(0)
      expect(await read()).toEqual({ content: source, revision })
      expect(writes).toEqual([])
      await append(page)
      const expected = source.replace('编辑目标。', '编辑目标。新增')
      await expect.poll(async () => (await read()).content).toBe(expected)
      expect(writes).toEqual([{ content: expected, match: `"${revision}"` }])
    } finally { await agent.dispose() }
  })
}

test('撤销恢复完整初始 source，重做继续条件保存', async ({ page, playwright }) => {
  const { agent, revision, writes, read } = await prepare(page, playwright, formatted)
  try {
    await expect(rich(page)).toBeVisible()
    await append(page)
    const edited = formatted.replace('编辑目标。', '编辑目标。新增')
    await expect.poll(async () => (await read()).content).toBe(edited)
    const saved = await read()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await read()).content).toBe(formatted)
    const undone = await read()
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await read()).content).toBe(edited)
    expect(writes).toEqual([
      { content: edited, match: `"${revision}"` },
      { content: formatted, match: `"${saved.revision}"` },
      { content: edited, match: `"${undone.revision}"` },
    ])
  } finally { await agent.dispose() }
})

test('格式差异原文通过 SSE 更新仍驻留 rich，不回写且接续使用新 ETag', async ({ page, playwright }) => {
  const { agent, url, revision, writes, read } = await prepare(page, playwright, formatted)
  try {
    await expect(rich(page)).toBeVisible()
    const remote = formatted.replace('保留尾段。', '远程尾段。')
    const response = await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: remote } })
    expect(response.status()).toBe(200)
    const remoteRevision = (await response.json()).revision
    await expect(rich(page)).toContainText('远程尾段。')
    await page.locator('.remote-notice').getByRole('button', { name: '等待', exact: true }).click()
    await expect(conversion(page)).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: '源码编辑器', exact: true })).toHaveCount(0)
    await page.waitForTimeout(1100)
    expect(await read()).toEqual({ content: remote, revision: remoteRevision })
    expect(writes).toEqual([])
    await append(page)
    const expected = remote.replace('编辑目标。', '编辑目标。新增')
    await expect.poll(async () => (await read()).content).toBe(expected)
    expect(writes).toEqual([{ content: expected, match: `"${remoteRevision}"` }])
    expect((await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: '不应覆盖' } })).status()).toBe(412)
  } finally { await agent.dispose() }
})

for (const [marker, language, trigger] of [
  ['~~~', 'c++', 'Space'], ['~~~~~', 'c#', 'Enter'],
  ['`````', 'shell-session', 'Space'], ['```', 'json', 'Enter'],
] as const) {
  test(`围栏输入 ${marker}${language} + ${trigger} 生成 Crepe 代码块并保存内容`, async ({ page, playwright }) => {
    const prefix = '保留标题\n========\n\n\n~~~text\n原有代码\n~~~\n\n'
    const { agent, read } = await prepare(page, playwright, `${prefix}编辑目标。\n`)
    try {
      await expect(rich(page)).toBeVisible()
      const paragraph = rich(page).locator('p').filter({ hasText: /^编辑目标。$/ })
      await paragraph.click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End')
      await page.keyboard.insertText(`${marker}${language}`)
      await page.keyboard.press(trigger)
      const blocks = page.locator('.milkdown-code-block')
      await expect(blocks).toHaveCount(2)
      const code = blocks.last().locator('.cm-content')
      await expect(code).toBeVisible()
      await code.fill('saved_code_42')
      await expect.poll(async () => (await read()).content).toContain('saved_code_42')
      const disk = (await read()).content
      expect(disk.startsWith(prefix)).toBe(true)
      expect(disk.slice(prefix.length)).toMatch(new RegExp('(?:`{3,}|~{3,})' + language.replace(/[+]/g, '\\+') + '\\n'))
      await page.getByRole('button', { name: '源码', exact: true }).click()
      await page.getByRole('button', { name: '富文本', exact: true }).click()
      await expect(blocks).toHaveCount(2)
      await expect(blocks.last().locator('.cm-content')).toContainText('saved_code_42')
      await expect(conversion(page)).toHaveCount(0)
    } finally { await agent.dispose() }
  })
}

test('全角与混合围栏不触发代码输入', async ({ page, playwright }) => {
  const { agent, read } = await prepare(page, playwright, '编辑目标。\n')
  try {
    await expect(rich(page)).toBeVisible()
    for (const marker of ['～～～json', '｀｀｀json', '~~`json', '``~json']) {
      await rich(page).locator('p').last().click()
      await page.keyboard.press('Home'); await page.keyboard.press('Shift+End')
      await page.keyboard.insertText(marker)
      await page.keyboard.press('Space')
      await expect(page.locator('.milkdown-code-block')).toHaveCount(0)
      await expect(rich(page)).toContainText(marker)
      await page.keyboard.press('Enter')
      await expect(page.locator('.milkdown-code-block')).toHaveCount(0)
    }
    await expect.poll(async () => (await read()).content).toContain('～～～json')
  } finally { await agent.dispose() }
})

for (const [name, source] of [
  ['frontmatter', '---\ntitle: 保留元数据\n---\n\n正文。\n'],
  ['未使用 reference definition', '[unused]: https://example.invalid/ "不能丢弃"\n\n正文。\n'],
  ['code info meta', '~~~json filename="keep.json"\n{"keep":true}\n~~~\n\n正文。\n'],
] as const) {
  test(`保护 ${name}：拒绝静默 rich 准入并完整保留原文`, async ({ page, playwright }) => {
    const { agent, revision, writes, read } = await prepare(page, playwright, source)
    try {
      await expect(conversion(page)).toBeVisible()
      await conversion(page).getByRole('button', { name: '保留原文，使用源码', exact: true }).click()
      await expect(page.getByRole('textbox', { name: '源码编辑器', exact: true })).toBeVisible()
      await page.waitForTimeout(1100)
      expect(await read()).toEqual({ content: source, revision })
      expect(writes).toEqual([])
    } finally { await agent.dispose() }
  })
}

test('真实段落 split 保留未编辑 raw blocks，不盲目重序列化全篇', async ({ page, playwright }) => {
  const { agent, revision, writes, read } = await prepare(page, playwright, formatted)
  try {
    await expect(rich(page)).toBeVisible()
    await rich(page).locator('p').filter({ hasText: /^编辑目标。$/ }).click()
    await rich(page).locator('p').filter({ hasText: /^编辑目标。$/ }).evaluate(element => {
      const text = element.firstChild
      if (!(text instanceof Text)) throw new Error('测试段落缺少文本节点')
      const range = document.createRange(); range.setStart(text, 2); range.collapse(true)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await page.keyboard.press('Enter')
    await expect(rich(page).locator('p').filter({ hasText: /^编辑$/ })).toBeVisible()
    await expect(rich(page).locator('p').filter({ hasText: /^目标。$/ })).toBeVisible()
    await expect.poll(async () => (await read()).content).not.toBe(formatted)
    const disk = (await read()).content
    const [prefix, suffix] = formatted.split('编辑目标。')
    expect(disk.startsWith(prefix)).toBe(true)
    expect(disk.endsWith(suffix)).toBe(true)
    expect(disk.slice(prefix.length, disk.length - suffix.length)).toMatch(/^编辑\s*\n\s*\n目标。$/)
    expect(writes).toHaveLength(1)
    expect(writes[0].match).toBe(`"${revision}"`)
    await page.getByRole('button', { name: '源码', exact: true }).click()
    await page.getByRole('button', { name: '富文本', exact: true }).click()
    await expect(conversion(page)).toHaveCount(0)
    await expect(rich(page).locator('p').filter({ hasText: /^目标。$/ })).toBeVisible()
  } finally { await agent.dispose() }
})

for (const marker of ['-', '1.']) test(`列表 ${marker} 回车新增项目仍可输入，保留未编辑尾段`, async ({ page, playwright }) => {
  const { agent, read } = await prepare(page, playwright, `${marker} 原有项\n\n尾段。\n`)
  try {
    await expect(rich(page)).toBeVisible()
    await rich(page).locator('li p').filter({ hasText: /^原有项$/ }).click()
    await page.keyboard.press('End'); await page.keyboard.press('Enter')
    await expect(rich(page).locator('li')).toHaveCount(2)
    await page.keyboard.insertText('新增项')
    await expect(rich(page).locator('li').last()).toContainText('新增项')
    await expect.poll(async () => (await read()).content).toContain('新增项')
    expect((await read()).content.endsWith('\n\n尾段。\n')).toBe(true)
    await expect(page.getByText(/此操作无法安全保留 Markdown/)).toHaveCount(0)
  } finally { await agent.dispose() }
})
