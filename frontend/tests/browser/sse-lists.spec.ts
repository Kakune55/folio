import { expect, test } from '@playwright/test'
import type { Page, Playwright } from '@playwright/test'

async function prepare(page: Page, playwright: Playwright, source: string) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  const connected = page.waitForResponse(response => response.url().includes('/workspace/events?') && response.status() === 200)
  await page.getByRole('button', { name: '进入工作区' }).click(); await connected
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const headers = { 'X-CSRF-Token': me.csrfToken }
  const path = `列表原文-${Date.now()}.md`
  const created = await page.request.post('/api/v1/files', { headers, data: { path, content: source } })
  expect(created.status()).toBe(201)
  await page.getByRole('button', { name: path, exact: true }).click()
  const token = await (await page.request.post('/api/v1/user/tokens', { headers, data: { name: '列表格式验收', permissions: { files: 'write', search: 'none', trash: 'none' }, expiresAt: 0 } })).json()
  const agent = await playwright.request.newContext({ baseURL: new URL(page.url()).origin, extraHTTPHeaders: { Authorization: `Bearer ${token.token}` } })
  const url = `/api/v1/files/content?path=${encodeURIComponent(path)}`
  const writes: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/v1/files/content' && ['PUT', 'PATCH'].includes(request.method())) writes.push(request.postData() ?? '')
  })
  return { agent, url, revision: (await created.json()).revision, writes }
}

const cases = [
  ['短横线', '- 第一项\n- 第二项\n\n正文。\n'],
  ['星号', '* 第一项\n* 第二项\n\n正文。\n'],
  ['加号', '+ 第一项\n+ 第二项\n\n正文。\n'],
  ['嵌套', '- 第一项\n  - 子项\n- 第二项\n\n正文。\n'],
  ['任务', '- [ ] 第一项\n- [x] 第二项\n\n正文。\n'],
  ['引用', '> - 第一项\n> - 第二项\n\n正文。\n'],
  ['代码内符号不参与风格判断', '```md\n* 仅为代码\n```\n\n- 第一项\n- 第二项\n\n正文。\n'],
] as const

for (const [name, source] of cases) test(`列表 ${name}：只读与 Agent 更新无回写，真实编辑保留符号`, async ({ page, playwright }) => {
  const { agent, url, revision, writes } = await prepare(page, playwright, source)
  try {
    const editor = page.getByRole('textbox', { name: 'Markdown 富文本编辑器', exact: true })
    await expect(editor).toBeVisible()
    await expect(page.getByRole('dialog', { name: '富文本转换预览' })).toHaveCount(0)
    await editor.click(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(1000)
    let disk = await (await agent.get(url)).json()
    expect(disk.content).toBe(source); expect(disk.revision).toBe(revision); expect(writes).toEqual([])

    const remote = source.replace('第二项', 'Agent 第二项')
    const changed = await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: remote } })
    expect(changed.status()).toBe(200)
    await expect(editor).toContainText('Agent 第二项')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const notice = page.locator('.remote-notice')
    await notice.getByRole('button', { name: '等待', exact: true }).click()
    await page.waitForTimeout(1000)
    disk = await (await agent.get(url)).json()
    expect(disk.content).toBe(remote); expect(disk.revision).toBe((await changed.json()).revision); expect(writes).toEqual([])

    const paragraph = editor.locator('p').filter({ hasText: /^正文。$/ })
    await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.insertText('新增')
    const edited = remote.replace('正文。', '正文。新增')
    await expect.poll(async () => (await (await agent.get(url)).json()).content).toBe(edited)
    expect(writes).toHaveLength(1)
    disk = await (await agent.get(url)).json()
    expect((await agent.put(url, { headers: { 'If-Match': `"${disk.revision}"` }, data: { content: edited.replace('新增', 'Agent 接续') } })).status()).toBe(200)
    expect((await agent.put(url, { headers: { 'If-Match': `"${revision}"` }, data: { content: '陈旧覆盖必须拒绝\n' } })).status()).toBe(412)
  } finally { await agent.dispose() }
})

test('混合列表风格仍需转换确认，取消不改写原始正文', async ({ page, playwright }) => {
  const source = '- 第一项\n\n+ 第二项\n\n正文。\n'
  const { agent, url, revision, writes } = await prepare(page, playwright, source)
  try {
    const dialog = page.getByRole('dialog', { name: '富文本转换预览' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '保留原文，使用源码', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '源码编辑器', exact: true })).toContainText('+ 第二项')
    await page.waitForTimeout(1000)
    const disk = await (await agent.get(url)).json()
    expect(disk.content).toBe(source); expect(disk.revision).toBe(revision); expect(writes).toEqual([])
  } finally { await agent.dispose() }
})
