import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function prepare(page: Page, source: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  const connected = page.waitForResponse(response => response.url().includes('/workspace/events?') && response.status() === 200)
  await page.getByRole('button', { name: '进入工作区' }).click(); await connected
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const path = `提示块-${Date.now()}-${test.info().testId.slice(-5)}.md`
  const created = await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': me.csrfToken }, data: { path, content: source } })
  expect(created.status()).toBe(201)
  const revision: string = (await created.json()).revision
  const expand = page.getByRole('button', { name: '展开文件列表', exact: true })
  if (await expand.isVisible()) await expand.click()
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name: path, exact: true }).click()
  const editor = page.locator('.source-host > .cm-editor > .cm-scroller > .cm-content')
  await expect(editor).toBeVisible()
  const writes: { content: string; match?: string }[] = []
  page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/files/content') writes.push({ content: request.postDataJSON().content, match: request.headers()['if-match'] }) })
  const read = async () => {
    const response = await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)
    const file = await response.json()
    expect(response.headers().etag).toBe(`"${file.revision}"`)
    return { content: file.content as string, revision: file.revision as string }
  }
  return { editor, read, writes, revision }
}
const types = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']
const labels = ['注意', '提示', '重要', '警告', '危险']

test('五种GitHub提示块有独立颜色图标，正文继续渲染Markdown且不写入', async ({ page }) => {
  const source = '\ufeff光标\r\n\r\n> [!NOTE]\r\n> **说明**与 `代码`。\n\n> [!TIP]\n> 提示正文。\r\r> [!IMPORTANT]\r> 重要正文。\n\n> [!WARNING]\n> 警告正文。\n\n> [!CAUTION]\n> 危险正文。\n\n尾部。'
  const { read, writes, revision } = await prepare(page, source)
  await expect(page.locator('.folio-alert-title')).toHaveCount(5)
  const colors: string[] = []
  for (const [index, type] of types.entries()) {
    const title = page.getByRole('group', { name: `提示块：${labels[index]}（${type}）`, exact: true })
    await expect(title).toHaveText(labels[index])
    await expect(title.locator('svg')).toHaveAttribute('aria-hidden', 'true')
    colors.push(await title.evaluate(element => getComputedStyle(element).color))
    const line = page.locator(`.folio-md-alert-${type.toLowerCase()}`).first()
    await expect(line).toHaveCSS('border-left-width', '4px')
    await expect(line).toHaveCSS('border-left-color', colors[index])
  }
  expect(new Set(colors).size).toBe(5)
  await expect(page.locator('.folio-md-strong')).toHaveText('说明')
  await expect(page.locator('.folio-md-inline-code')).toContainText('代码')
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('进入块内显示原标记，编辑类型、切换模式与撤销保留混合换行及同View', async ({ page }) => {
  const source = '\ufeff光标\r\n\r\n> [!NOTE]\r> 内容及空白  \n>\r\n> 第二段。\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  await editor.evaluate(element => element.setAttribute('data-test-instance', '提示块编辑器'))
  await page.getByRole('group', { name: '提示块：注意（NOTE）', exact: true }).click()
  await expect(page.locator('.folio-alert-title')).toHaveCount(0)
  await expect(editor.locator('.cm-line').filter({ hasText: /^> \[!NOTE\]$/ })).toBeVisible()
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await page.keyboard.insertText('> [!WARNING]')
  const changed = source.replace('[!NOTE]', '[!WARNING]')
  await expect.poll(async () => (await read()).content).toBe(changed)
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toEqual({ content: changed, match: `"${revision}"` })
  await page.keyboard.press('ControlOrMeta+End')
  await expect(page.getByRole('group', { name: '提示块：警告（WARNING）', exact: true })).toBeVisible()
  await editor.locator('.cm-line').filter({ hasText: '第二段。' }).click()
  await expect(page.locator('.folio-alert-title')).toHaveCount(0)
  await expect(editor.locator('.cm-line').filter({ hasText: /^> \[!WARNING\]$/ })).toBeVisible()
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(page.locator('.folio-md-alert-line')).toHaveCount(0)
  await expect(editor).toHaveAttribute('data-test-instance', '提示块编辑器')
  await editor.focus(); await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await read()).content).toBe(source)
  await page.getByRole('button', { name: '实时预览', exact: true }).click()
  await editor.focus(); await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect.poll(async () => (await read()).content).toBe(changed)
  await page.keyboard.press('ControlOrMeta+End')
  await expect(page.locator('.folio-alert-title')).toHaveAttribute('data-alert-type', 'WARNING')
  await expect(editor).toHaveAttribute('data-test-instance', '提示块编辑器')
})

test('未知自定义嵌套和代码标记保持原样，标题不误打开引用链接', async ({ page }) => {
  const source = '光标\n\n> [!UNKNOWN]\n> 未知类型\n\n> [!WARNING] 自定义标题\n> 普通引用\n\n> > [!NOTE]\n> > 嵌套引用\n\n```text\n> [!NOTE]\n```\n\n> [!TIP]\n> [正文链接](./note.md) 与 <img src=x onerror=alert(1)>\n\n[!TIP]: ./wrong.md\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  await expect(page.locator('.folio-alert-title')).toHaveCount(1)
  await expect(page.locator('.folio-alert-title')).toHaveAttribute('data-alert-type', 'TIP')
  await expect(editor.locator('.cm-line').filter({ hasText: '[!UNKNOWN]' })).toBeVisible()
  await expect(editor.locator('.cm-line').filter({ hasText: '[!WARNING] 自定义标题' })).toBeVisible()
  await expect(page.locator('.folio-md-link')).toHaveCount(1)
  await expect(editor.locator('img[src], script, [onerror]')).toHaveCount(0)
  const wrongRequests: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === '/api/v1/files/content' && url.searchParams.get('path')?.endsWith('wrong.md')) wrongRequests.push(request.url())
  })
  await page.locator('.folio-alert-title').click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.folio-alert-title')).toHaveCount(0)
  expect(wrongRequests).toEqual([])
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('手机明暗提示块颜色对比和排版可访问，查看主题切换不保存', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const source = '光标\n\n' + types.map((type, i) => `> [!${type}]\n> ${labels[i]}：这是一条用于检查自动换行的提示信息。`).join('\n\n') + '\n\n尾部。'
  const { read, writes, revision } = await prepare(page, source)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    await expect(page.locator('.folio-alert-title')).toHaveCount(5)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
  }
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})
