import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function prepare(page: Page, options: { failFirst?: boolean; extra?: string } = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  const connected = page.waitForResponse(response => response.url().includes('/workspace/events?') && response.status() === 200)
  await page.getByRole('button', { name: '进入工作区' }).click(); await connected
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1000
    const context = canvas.getContext('2d')!
    context.fillStyle = '#5365b8'; context.fillRect(0, 0, 1600, 1000)
    context.fillStyle = '#fff'; context.font = '64px sans-serif'; context.fillText('Folio Image Preview', 100, 200)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const upload = await page.request.post('/api/v1/uploads?image=true', { headers: { 'X-CSRF-Token': me.csrfToken }, multipart: { file: { name: `放大示例-${Date.now()}-${test.info().testId.slice(-5)}.png`, mimeType: 'image/png', buffer: Buffer.from(png, 'base64') } } })
  expect(upload.status()).toBe(201)
  const imagePath: string = (await upload.json()).path
  let previews = 0
  await page.route('**/api/v1/files/preview?**', route => {
    if (new URL(route.request().url()).searchParams.get('path') !== imagePath) return route.continue()
    previews++
    if (options.failFirst && previews === 1) return route.fulfill({ status: 404, contentType: 'text/plain', body: '暂时不可用' })
    return route.continue()
  })
  const href = './' + imagePath.split('/').map(encodeURIComponent).join('/')
  const source = `\ufeff光标\r\n\r\n![示例图片](${href})\n\n${options.extra || ''}尾部。`
  const path = `图片展示-${Date.now()}-${test.info().testId.slice(-5)}.md`
  const created = await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': me.csrfToken }, data: { path, content: source } })
  expect(created.status()).toBe(201)
  const revision: string = (await created.json()).revision
  const expand = page.getByRole('button', { name: '展开文件列表', exact: true })
  if (await expand.isVisible()) await expand.click()
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
  return { editor, source, revision, read, writes, imagePath, previews: () => previews }
}

test('笔记图片点击放大、原始尺寸局部滚动、下载关闭返回编辑器且零写入', async ({ page }) => {
  const { editor, source, revision, read, writes } = await prepare(page)
  const image = page.locator('.folio-preview-image img')
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1600)
  await expect(page.locator('.folio-preview-image')).toContainText('1600 × 1000 像素')
  await editor.focus()
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true })
  await expect(dialog.getByRole('button', { name: '适应窗口', exact: true })).toBeEnabled()
  await expect(dialog.getByText('1600 × 1000 像素')).toBeVisible()
  expect(await dialog.locator('img').evaluate(element => element.clientWidth)).toBeLessThan(1600)
  await dialog.getByRole('button', { name: '原始尺寸', exact: true }).click()
  expect(await dialog.locator('img').evaluate(element => element.clientWidth)).toBe(1600)
  expect(await dialog.locator('.image-preview-stage').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await dialog.getByRole('button', { name: '适应窗口', exact: true }).click()
  expect(await dialog.locator('img').evaluate(element => element.clientWidth)).toBeLessThan(1600)
  const downloaded = page.waitForEvent('download')
  await dialog.getByRole('link', { name: '下载原图', exact: true }).click()
  const download = await downloaded
  expect(await download.failure()).toBeNull()
  expect(download.suggestedFilename()).toMatch(/\.png$/)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0); await expect(editor).toBeFocused()
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('图片失败可从原地址重试，成功清除错误，Ctrl点击仍打开图片文件', async ({ page }) => {
  const { source, revision, read, writes, previews } = await prepare(page, { failFirst: true })
  await expect(page.getByText('图片加载失败，源码已保留；可重试或检查文件地址。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '放大图片：示例图片', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '重试图片', exact: true }).click()
  await expect(page.getByRole('button', { name: '放大图片：示例图片', exact: true })).toBeEnabled()
  expect(previews()).toBe(2)
  await expect(page.locator('.folio-preview-image')).toContainText('1600 × 1000 像素')
  await expect(page.getByText('图片加载失败，源码已保留；可重试或检查文件地址。', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.image-viewer img')).toBeVisible()
  await page.locator('.image-viewer .image-open').click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true })
  await expect(dialog.getByText('1600 × 1000 像素')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭图片预览', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('外部和越界图片不触发放大或外部请求，原文与版本不变', async ({ page }) => {
  const external: string[] = []
  page.on('request', request => { if (!['http://127.0.0.1:5173', 'http://127.0.0.1:18081'].includes(new URL(request.url()).origin)) external.push(request.url()) })
  const { source, revision, read, writes } = await prepare(page, { extra: '![外部](https://evil.test/track.png)\n\n![越界](../../secret.png)\n\n' })
  await expect(page.getByText('不支持外部图片地址，源码已保留。', { exact: true })).toBeVisible()
  await expect(page.getByText('图片地址不可用，源码已保留。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^放大图片：/ })).toHaveCount(1)
  expect(external).toEqual([])
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('手机明暗大图弹窗可访问，关闭和尺寸切换不影响正文', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { source, revision, read, writes } = await prepare(page)
  await expect(page.getByRole('button', { name: '放大图片：示例图片', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true })
  await expect(dialog.getByRole('button', { name: '原始尺寸', exact: true })).toBeEnabled()
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    await dialog.getByRole('button', { name: '原始尺寸', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await dialog.getByRole('button', { name: '适应窗口', exact: true }).click()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
  }
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('输入法候选期间不会打开图片弹窗或提前保存', async ({ page }) => {
  const { editor, source, revision, read, writes } = await prepare(page)
  const trigger = page.getByRole('button', { name: '放大图片：示例图片', exact: true })
  await expect(trigger).toBeEnabled()
  await editor.focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('End')
  const protocol = await page.context().newCDPSession(page)
  try {
    await protocol.send('Input.imeSetComposition', { text: '候选', selectionStart: 2, selectionEnd: 2 })
    await expect(page.locator('.save-status')).toHaveText('输入法候选待确认，自动保存暂停')
    await trigger.dispatchEvent('click')
    await expect(page.getByRole('dialog', { name: '图片预览', exact: true })).toHaveCount(0)
    await expect(page.getByText('请先确认或取消输入法候选，再放大图片。', { exact: true })).toBeVisible()
    await page.waitForTimeout(800) // 跨过自动保存窗口，候选不得写入服务端。
    expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
    await protocol.send('Input.insertText', { text: '确认' })
    await expect.poll(async () => (await read()).content).toBe(source.replace('光标', '光标确认'))
  } finally { await protocol.detach().catch(() => {}) }
})
