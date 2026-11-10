import { test, expect } from '@playwright/test'

for (const mode of ['实时预览', '源码']) test(`${mode}侧栏文件引用真实拖入、条件保存与撤销保留原文`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const headers = { 'X-CSRF-Token': principal.csrfToken }
  const id = Date.now(), name = `拖入-${id}.md`, target = `引用 中文-${id}.json`
  const original = '\uFEFF# 标题\r\n\r\n第一段\r\n\r\n第二段\r\n'
  for (const [path, content] of [[name, original], [target, '{"保留":true}']]) expect((await page.request.post('/api/v1/files', { headers, data: { path, content } })).status()).toBe(201)
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name, exact: true }).click()
  if (mode === '源码') await page.getByRole('button', { name: mode, exact: true }).click()
  const editor = page.locator('.cm-content')
  await editor.focus()
  expect(await editor.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none')
  let moves = 0, uploads = 0
  page.on('request', request => {
    if (request.url().includes('/entries/move')) moves++
    if (request.url().includes('/uploads?')) uploads++
  })
  const url = `/api/v1/files/content?path=${encodeURIComponent(name)}`
  const before = await (await page.request.get(url)).json()
  const write = page.waitForRequest(request => request.method() === 'PUT' && request.url().includes('/files/content?'))
  await page.getByRole('button', { name: target, exact: true }).dragTo(editor, { targetPosition: { x: 60, y: 16 } })
  expect((await write).headers()['if-match']).toBe(`"${before.revision}"`)
  await expect.poll(async () => (await (await page.request.get(url)).json()).content).toContain(encodeURIComponent(target))
  const saved = (await (await page.request.get(url)).json()).content as string
  expect(saved.replace(/\[(?:\\.|[^\]\\])*\]\([^)]+\)/g, '')).toBe(original)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await (await page.request.get(url)).json()).content).toBe(original)
  expect((await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(target)}`)).json()).content).toBe('{"保留":true}')
  expect(moves).toBe(0); expect(uploads).toBe(0)
})
