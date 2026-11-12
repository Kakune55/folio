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
  const path = `公式-${Date.now()}-${test.info().testId.slice(-5)}.md`
  const created = await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': me.csrfToken }, data: { path, content: source } })
  expect(created.status()).toBe(201)
  const revision: string = (await created.json()).revision
  const expandFiles = page.getByRole('button', { name: '展开文件列表', exact: true })
  if (await expandFiles.isVisible()) await expandFiles.click()
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

test('行内及独立LaTeX公式渲染，普通金额与转义美元保持原样且零写入', async ({ page }) => {
  const source = '\ufeff光标\r\n\r\n价格 $5、$9.99，区间 $10 到 $20，成对金额 $20$，转义 \\$x\\$。\n\n相邻金额 $20$和$x$。\n\n行内 $E=mc^2$、$2+2$ 和 $\\frac{a}{b}+\\sqrt{x}$。\r\n\r\n$$\r\n\\sum_{i=1}^{n}i\r\n$$\n\n$$\n\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  await expect(page.locator('.folio-math-preview[data-state="ready"]')).toHaveCount(6)
  await expect(page.locator('.folio-math-display')).toHaveCount(2)
  await expect(page.locator('.folio-math-preview math')).toHaveCount(6)
  const money = editor.locator('.cm-line').filter({ hasText: '价格' })
  await expect(money).toContainText('价格 $5、$9.99，区间 $10 到 $20，成对金额 $20$，转义 $x$。')
  await expect(money.locator('.folio-math-preview')).toHaveCount(0)
  await expect(editor.locator('.cm-line').filter({ hasText: '相邻金额' })).toContainText('相邻金额 $20$和')
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('点击公式编辑原文，模式切换保留同View、混合换行和撤销历史', async ({ page }) => {
  const source = '\ufeff光标\r\n\r\n$x^2$\n\n$$\rx+y\r$$\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  await editor.evaluate(element => element.setAttribute('data-test-instance', '同一编辑器'))
  await expect(page.locator('.folio-math-preview[data-state="ready"]')).toHaveCount(2)
  await page.getByRole('group', { name: '行内数学公式', exact: true }).click()
  await expect(editor.locator('.cm-line').filter({ hasText: /^\$x\^2\$$/ })).toBeVisible()
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await page.keyboard.insertText('$y^2$')
  const changed = source.replace('$x^2$', '$y^2$')
  await expect.poll(async () => (await read()).content).toBe(changed)
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toEqual({ content: changed, match: `"${revision}"` })
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(page.locator('.folio-math-preview')).toHaveCount(0)
  await expect(editor).toHaveAttribute('data-test-instance', '同一编辑器')
  await editor.focus(); await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await read()).content).toBe(source)
  await page.getByRole('button', { name: '实时预览', exact: true }).click()
  await editor.focus(); await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect.poll(async () => (await read()).content).toBe(changed)
  await page.keyboard.press('ControlOrMeta+End')
  await expect(page.locator('.folio-math-preview[data-state="ready"]')).toHaveCount(2)
  await expect(editor).toHaveAttribute('data-test-instance', '同一编辑器')
  await page.getByRole('group', { name: '独立数学公式', exact: true }).click()
  await expect(editor.locator('.cm-line').filter({ hasText: /^x\+y$/ })).toBeVisible()
})

test('错误和活动命令明确报错，可回到源码修复，不加载外部资源', async ({ page }) => {
  const external: string[] = []
  page.on('request', request => { if (new URL(request.url()).origin !== 'http://127.0.0.1:5173' && new URL(request.url()).origin !== 'http://127.0.0.1:18081') external.push(request.url()) })
  const source = '光标\n\n$\\noSuchCommand{x}$\n\n$\\href{javascript:alert(1)}{x}$\n\n$\\includegraphics{https://evil.test/x.png}$\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  await expect(page.locator('.folio-math-preview[data-state="error"]')).toHaveCount(3)
  await expect(page.locator('.folio-math-preview img, .folio-math-preview a[href], .folio-math-preview script')).toHaveCount(0)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
  await page.locator('.folio-math-preview').first().click()
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await page.keyboard.insertText('$z^2$')
  await page.keyboard.press('ControlOrMeta+End')
  await expect(page.locator('.folio-math-preview[data-state="ready"]')).toHaveCount(1)
  await expect(page.locator('.folio-math-preview[data-state="error"]')).toHaveCount(2)
  await expect.poll(async () => (await read()).content).toBe(source.replace('$\\noSuchCommand{x}$', '$z^2$'))
  await expect(editor.locator('[onerror]')).toHaveCount(0)
  expect(external).toEqual([])
})

test('明暗手机公式可访问，宽公式仅局部滚动，代码内不误渲染', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const source = '光标\n\n内联 $E=mc^2$。\n\n$$\n' + Array.from({ length: 25 }, (_, i) => `x_{${i}}`).join('+') + '\n$$\n\n`$x^2$`\n\n```text\n$x^2$\n```\n\n尾部。'
  const { read, writes, revision } = await prepare(page, source)
  await expect(page.locator('.folio-math-preview[data-state="ready"]')).toHaveCount(2)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('.folio-math-display').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
  }
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('输入法候选期间点击公式不抢焦点或提前保存，确认后原文接续保存', async ({ page }) => {
  const source = '编辑目标。\n\n$x^2$\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  await expect(page.locator('.folio-math-preview[data-state="ready"]')).toHaveCount(1)
  await editor.locator('.cm-line').filter({ hasText: '编辑目标。' }).click()
  await page.keyboard.press('End')
  await expect(editor).toBeFocused()
  const protocol = await page.context().newCDPSession(page)
  try {
    await protocol.send('Input.imeSetComposition', { text: '候选', selectionStart: 2, selectionEnd: 2 })
    await expect(page.locator('.save-status')).toHaveText('输入法候选待确认，自动保存暂停')
    await page.getByRole('group', { name: '行内数学公式', exact: true }).dispatchEvent('click')
    await expect(page.locator('.folio-math-preview[data-state="ready"]')).toHaveCount(1)
    await expect(page.getByText('请先确认或取消输入法候选，再编辑公式源码。', { exact: true })).toBeVisible()
    await page.waitForTimeout(800) // 跨过自动保存窗口，候选仍不得写入服务端。
    expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
    await protocol.send('Input.insertText', { text: '确认' })
    await expect.poll(async () => (await read()).content).toBe(source.replace('编辑目标。', '编辑目标。确认'))
  } finally { await protocol.detach().catch(() => {}) }
})
