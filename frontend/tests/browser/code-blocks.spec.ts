import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function prepare(page: Page, source: string) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  const ready = page.waitForResponse(response => response.url().includes('/workspace/events?') && response.status() === 200)
  await page.getByRole('button', { name: '进入工作区' }).click(); await ready
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const path = `代码块-${Date.now()}.md`
  const created = await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': me.csrfToken }, data: { path, content: source } })
  expect(created.status()).toBe(201)
  const revision = (await created.json()).revision as string
  const showFiles = page.getByRole('button', { name: '展开文件列表', exact: true })
  if (await showFiles.isVisible()) await showFiles.click()
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name: path, exact: true }).click()
  const editor = page.locator('.source-host .cm-content')
  await expect(editor).toBeVisible()
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/files/content') writes.push(request.postDataJSON().content) })
  const read = async () => {
    const response = await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)
    const file = await response.json()
    expect(response.headers().etag).toBe(`"${file.revision}"`)
    return { content: file.content as string, revision: file.revision as string }
  }
  return { editor, read, writes, revision }
}

test('py和js围栏实际高亮，语言标签与主题切换不回写', async ({ page }) => {
  const source = '# 代码\n\n~~~~py filename="keep.py"\ndef greet():\n    return "hello"\n~~~~\n\n```js\nconst value = 42;\n```\n\n~~~custom\nunknown\n~~~\n\n```\nplain\n```\n'
  const { editor, read, writes, revision } = await prepare(page, source)
  const python = page.locator('.folio-code-tools[data-language="py"]')
  await expect(python.locator('.folio-code-language')).toHaveText('Python')
  await expect(page.locator('.folio-code-tools[data-language="custom"] .folio-code-language')).toHaveText('custom')
  await expect(page.locator('.folio-code-tools[data-language="text"] .folio-code-language')).toHaveText('纯文本')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    for (const word of ['def', 'const']) {
      const token = editor.locator('.cm-line span').filter({ hasText: new RegExp(`^${word}$`) })
      await expect(token).toHaveCount(1)
      const color = await token.evaluate(element => getComputedStyle(element).color)
      expect(color).not.toBe(await editor.evaluate(element => getComputedStyle(element).color))
    }
  }
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(page.locator('.folio-code-tools')).toHaveCount(0)
  await expect(editor.locator('.cm-line span').filter({ hasText: /^def$/ })).toHaveCount(1)
  await page.getByRole('button', { name: '实时预览', exact: true }).click()
  await expect(python).toBeVisible()
  await page.waitForTimeout(1100)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('代码复制保留原始空白和混合换行，不包含围栏或文件BOM', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const source = '\ufeff~~~~py filename="keep.py"\r\n  a  \r\nb\n~~~~\r\n'
  const { editor, read, writes, revision } = await prepare(page, source)
  const copy = page.locator('.folio-code-tools[data-language="py"]').getByRole('button', { name: '复制代码', exact: true })
  await copy.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('  a  \r\nb\n')
  await expect(copy).toHaveText('已复制')
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
  await editor.focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('前缀\n\n')
  await expect.poll(async () => (await read()).content).toBe('\ufeff前缀\r\n\r\n' + source.slice(1))
  await expect.poll(() => writes.length).toBe(1)
  await copy.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('  a  \r\nb\n')
  expect(writes).toHaveLength(1)
})

test('代码复制失败明确提示，手机控件可用且正文版本不变', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const source = '~~~go\npackage main\n~~~\n'
  const { read, writes, revision } = await prepare(page, source)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }))
  const copy = page.getByRole('button', { name: '复制代码', exact: true })
  await copy.click()
  await expect(page.getByText('无法写入剪贴板，正文未改动；请在源码中选择代码手动复制。')).toBeVisible()
  expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(40)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.waitForTimeout(1100)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})
