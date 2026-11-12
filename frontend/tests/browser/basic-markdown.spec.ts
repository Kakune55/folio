import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function prepare(page: Page, source: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1280, height: 1100 })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  const ready = page.waitForResponse(response => response.url().includes('/workspace/events?') && response.status() === 200)
  await page.getByRole('button', { name: '进入工作区' }).click(); await ready
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const path = `基础语法-${Date.now()}-${test.info().testId.slice(-5)}.md`
  const created = await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': me.csrfToken }, data: { path, content: source } })
  expect(created.status()).toBe(201)
  const revision = (await created.json()).revision as string
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name: path, exact: true }).click()
  const editor = page.locator('.source-host > .cm-editor > .cm-scroller > .cm-content')
  await expect(editor).toBeVisible()
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/files/content') writes.push(request.postDataJSON().content) })
  const read = async () => {
    const response = await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)
    const file = await response.json()
    expect(response.headers().etag).toBe(`"${file.revision}"`)
    return { content: file.content as string, revision: file.revision as string }
  }
  return { editor, writes, read, revision }
}

test('各种分割线实际渲染，点击可编辑原标记，模式主题切换不改字节', async ({ page }) => {
  const source = '\ufeff光标\r\n\r\n---\n\n***\r\r___\n\n- - -\n\n* * *\n\n_ _ _\n\n> ---\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    await expect(page.getByRole('separator', { name: '分割线' })).toHaveCount(7)
    const rule = page.locator('.folio-md-rule').first()
    expect(await rule.evaluate(element => getComputedStyle(element, '::after').borderTopWidth)).toBe('1px')
  }
  await page.getByRole('separator', { name: '分割线' }).first().click()
  await expect(page.getByRole('separator', { name: '分割线' })).toHaveCount(6)
  await expect(editor.locator('.cm-line').filter({ hasText: /^---$/ })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+End')
  await expect(page.getByRole('separator', { name: '分割线' })).toHaveCount(7)
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(page.locator('.folio-md-rule')).toHaveCount(0)
  await page.getByRole('button', { name: '实时预览', exact: true }).click()
  await expect(page.locator('.folio-md-rule')).toHaveCount(7)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('分割线与Setext和代码区分，编辑分割线可按原始换行撤销', async ({ page }) => {
  const source = '光标\r\n\r\n标题\r\n---\r\n\r\n```text\r\n***\r\n```\r\n\r\n    ___\r\n\r\n\\---\r\n\r\n---\r\n\r\n尾部。'
  const { read } = await prepare(page, source)
  await expect(page.locator('.folio-md-rule')).toHaveCount(1)
  await expect(page.locator('.folio-md-heading-2').filter({ hasText: '标题' })).toBeVisible()
  await page.getByRole('separator', { name: '分割线' }).click()
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await page.keyboard.insertText('正文')
  await expect.poll(async () => (await read()).content).toBe(source.replace('\r\n---\r\n\r\n尾部。', '\r\n正文\r\n\r\n尾部。'))
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await read()).content).toBe(source)
})

test('六级标题、Setext、强调和行内代码的基础显示', async ({ page }) => {
  const source = '光标\n\n# 一级\n## 二级\n### 三级\n#### 四级\n##### 五级\n###### 六级\n\nSetext一级\n===\n\nSetext二级\n---\n\n*斜体* **粗体** ***粗斜体*** ~~删除~~ `行内代码`\n\n尾部。'
  const { read, writes, revision } = await prepare(page, source)
  for (let level = 1; level <= 6; level++) await expect(page.locator(`.folio-md-heading-${level}`).first()).toBeVisible()
  await expect(page.locator('.folio-md-emphasis').first()).toHaveCSS('font-style', 'italic')
  await expect(page.locator('.folio-md-strong').first()).toHaveCSS('font-weight', '700')
  await expect(page.locator('.folio-md-strike')).toHaveCSS('text-decoration-line', 'line-through')
  await expect(page.locator('.folio-md-inline-code')).toBeVisible()
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('引用、嵌套列表、任务、链接与代码块保留基本显示和安全边界', async ({ page }) => {
  const source = '光标\n\n> 引用\n>\n> > 嵌套引用\n\n- 项目\n  - 子项\n\n3. 第三项\n4. 第四项\n\n- [ ] 未完成\n- [x] 已完成\n\n[直接链接](./note.md) 和 [引用链接][id]\n\n[id]: ./note.md "标题"\n\n~~~js\nconst value = 42\n~~~\n\n    缩进代码\n\n<div onclick="alert(1)">保留HTML源码</div>\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  await expect(page.locator('.folio-md-quote-line').first()).toHaveCSS('border-left-width', '2px')
  await expect(page.locator('.folio-md-list-marker')).toHaveCount(4)
  await expect(page.locator('.folio-md-ordered-marker')).toHaveText(['3.', '4.'])
  await expect(page.getByRole('checkbox', { name: '标记为已完成', exact: true })).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByRole('checkbox', { name: '标记为未完成', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.folio-md-link')).toHaveCount(2)
  await expect(page.locator('.folio-code-language')).toHaveText('JavaScript')
  await expect(page.locator('.folio-md-code-line').filter({ hasText: '缩进代码' })).toBeVisible()
  await expect(editor.locator('[onclick]')).toHaveCount(0)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('转义、实体与硬换行正确显示，实体解码不产生可执行HTML', async ({ page }) => {
  const source = '\ufeff光标\r\n\r\n\\*普通\\* &amp; &#65; &copy; &notreal; &lt;img src=x onerror=alert(1)&gt;\n\n反斜线\\\r\n下一行  \n末行\n\n`&amp; \\* ---`\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  const line = editor.locator('.cm-line').filter({ hasText: '普通' })
  await expect(line).toHaveText('*普通* & A © &notreal; <img src=x onerror=alert(1)>')
  await expect(editor.locator('.cm-line').filter({ hasText: '反斜线' })).toHaveText('反斜线')
  await expect(editor.locator('img[src], script, [onerror], .folio-md-entity img')).toHaveCount(0)
  await expect(page.locator('.folio-md-inline-code')).toContainText('&amp; \\* ---')
  await line.click()
  await expect(line).toHaveText('\\*普通\\* &amp; &#65; &copy; &notreal; &lt;img src=x onerror=alert(1)&gt;')
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('有效引用和两种自动链接显示并可跳转，未定义引用保留完整源码', async ({ page }) => {
  const source = '光标\n\n[引用][id] [无效][missing] [无定义]\n\n<https://example.com/angle>\n\nhttps://example.com/bare\n\nwww.example.org\n\n[id]: ./note.md "标题"\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  await expect(page.locator('.folio-md-link')).toHaveText(['引用', 'https://example.com/angle', 'https://example.com/bare', 'www.example.org'])
  await expect(editor.locator('.cm-line').filter({ hasText: '[无效][missing]' })).toContainText('[无定义]')
  await page.context().route('https://example.com/**', route => route.fulfill({ contentType: 'text/plain', body: '链接目标' }))
  for (const target of ['https://example.com/angle', 'https://example.com/bare']) {
    const popup = page.waitForEvent('popup')
    await page.locator('.folio-md-link').filter({ hasText: target }).click({ modifiers: ['ControlOrMeta'] })
    const opened = await popup
    await opened.waitForLoadState()
    expect(opened.url()).toBe(target)
    await opened.close()
  }
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})
