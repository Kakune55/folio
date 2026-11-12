import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'

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
  return { editor, source, revision, read, writes, imagePath, originalPNG: png, previews: () => previews }
}

async function stroke(page: Page, tool: string, from: { x: number; y: number }, to: { x: number; y: number }, shift = false) {
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true })
  await dialog.getByRole('button', { name: tool, exact: true }).click()
  const box = (await dialog.locator('img').boundingBox())!
  if (shift) await page.keyboard.down('Shift')
  try {
    await page.mouse.move(box.x + from.x / 1600 * box.width, box.y + from.y / 1000 * box.height)
    await page.mouse.down()
    await page.mouse.move(box.x + to.x / 1600 * box.width, box.y + to.y / 1000 * box.height, { steps: 8 })
    await page.mouse.up()
  } finally { if (shift) await page.keyboard.up('Shift') }
}

test('图片居中暗色画布、原始尺寸、下载关闭返回编辑器且零写入', async ({ page }) => {
  const { editor, source, revision, read, writes } = await prepare(page)
  const image = page.locator('.folio-preview-image img')
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1600)
  await expect(page.locator('.folio-preview-image')).toContainText('1600 × 1000 像素')
  await editor.focus()
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true })
  await expect(dialog.getByRole('button', { name: '适应窗口', exact: true })).toBeEnabled()
  await expect(dialog.getByText('1600 × 1000 像素')).toBeVisible()
  const stage = dialog.locator('.image-preview-stage')
  const fitted = (await dialog.locator('img').boundingBox())!, canvas = (await stage.boundingBox())!
  expect(fitted.width).toBeLessThan(1600)
  expect(fitted.x + fitted.width / 2).toBeCloseTo(canvas.x + canvas.width / 2, 0)
  expect(fitted.y + fitted.height / 2).toBeCloseTo(canvas.y + canvas.height / 2, 0)
  await expect(page.locator('.image-preview-overlay')).toHaveCSS('background-color', 'rgba(5, 8, 13, 0.94)')
  await dialog.getByRole('button', { name: '原始尺寸', exact: true }).click()
  expect((await dialog.locator('img').boundingBox())!.width).toBe(1600)
  await expect(stage).toHaveAttribute('data-scale', '1')
  await expect(stage).toHaveCSS('overflow', 'hidden')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await dialog.getByRole('button', { name: '适应窗口', exact: true }).click()
  expect((await dialog.locator('img').boundingBox())!.width).toBeLessThan(1600)
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
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
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

test('滚轮锚定缩放、鼠标拖拽、双击和键盘复位不写入正文', async ({ page }) => {
  const { source, revision, read, writes } = await prepare(page)
  await expect(page.getByRole('button', { name: '放大图片：示例图片', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true }), stage = dialog.getByRole('region', { name: '图片缩放画布', exact: true })
  await expect(dialog.getByRole('button', { name: '适应窗口', exact: true })).toBeEnabled()
  const value = () => stage.evaluate(element => ({ scale: Number(element.dataset.scale), x: Number(element.dataset.x), y: Number(element.dataset.y) }))
  const box = (await stage.boundingBox())!, initial = await value()
  const anchor = { x: 120, y: -60 }
  await page.mouse.move(box.x + box.width / 2 + anchor.x, box.y + box.height / 2 + anchor.y)
  await page.mouse.wheel(0, -220)
  await expect.poll(async () => (await value()).scale).toBeGreaterThan(initial.scale)
  const zoomed = await value()
  expect((anchor.x - zoomed.x) / zoomed.scale).toBeCloseTo((anchor.x - initial.x) / initial.scale, 3)
  expect((anchor.y - zoomed.y) / zoomed.scale).toBeCloseTo((anchor.y - initial.y) / initial.scale, 3)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 70, { steps: 5 }); await page.mouse.up()
  const dragged = await value()
  expect(dragged.x - zoomed.x).toBeCloseTo(120, 0); expect(dragged.y - zoomed.y).toBeCloseTo(70, 0)
  await expect(dialog).toBeVisible(); await expect(stage).toHaveAttribute('data-dragging', 'false')
  await dialog.getByRole('button', { name: '适应窗口', exact: true }).click()
  await expect(stage).toHaveAttribute('data-x', '0'); await expect(stage).toHaveAttribute('data-y', '0')
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
  await expect(stage).toHaveAttribute('data-scale', '1')
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
  await expect.poll(async () => (await value()).scale).toBeCloseTo(initial.scale, 4)
  await stage.focus(); await page.keyboard.press('+'); await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await value()).scale).toBeGreaterThan(initial.scale)
  await expect(stage).toHaveAttribute('data-x', '40')
  await page.keyboard.press('0')
  await expect(stage).toHaveAttribute('data-x', '0')
  await dialog.getByRole('button', { name: '放大图片', exact: true }).click()
  await expect.poll(async () => (await value()).scale).toBeGreaterThan(initial.scale)
  await dialog.getByRole('button', { name: '缩小图片', exact: true }).click()
  await expect.poll(async () => (await value()).scale).toBeCloseTo(initial.scale, 4)
  await dialog.getByRole('button', { name: '适应窗口', exact: true }).click()
  await page.mouse.click(box.x + 5, box.y + box.height / 2)
  await expect(dialog).toHaveCount(0)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('手机单指拖动和双指缩放仅改变图片，不触发整页缩放或误关闭', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { source, revision, read, writes } = await prepare(page)
  await expect(page.getByRole('button', { name: '放大图片：示例图片', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true }), stage = dialog.getByRole('region', { name: '图片缩放画布', exact: true })
  await expect(dialog.getByRole('button', { name: '原始尺寸', exact: true })).toBeEnabled()
  const box = (await stage.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2
  const initial = await stage.evaluate(element => Number(element.dataset.scale))
  const protocol = await page.context().newCDPSession(page)
  try {
    await protocol.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x - 50, y }, { id: 2, x: x + 50, y }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x - 100, y }, { id: 2, x: x + 100, y }] })
    await expect.poll(() => stage.evaluate(element => Number(element.dataset.scale))).toBeCloseTo(initial * 2, 2)
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(stage).toHaveAttribute('data-dragging', 'false')
    const before = await stage.evaluate(element => ({ x: Number(element.dataset.x), y: Number(element.dataset.y) }))
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x + 40, y: y + 50 }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const after = await stage.evaluate(element => ({ x: Number(element.dataset.x), y: Number(element.dataset.y) }))
    expect(after.x - before.x).toBeCloseTo(40, 0); expect(after.y - before.y).toBeCloseTo(50, 0)
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '适应窗口', exact: true }).click()
    await expect(stage).toHaveAttribute('data-x', '0'); await expect(stage).toHaveAttribute('data-y', '0')
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    await expect(stage).toHaveAttribute('data-dragging', 'false')
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: box.x + 5, y }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(dialog).toHaveCount(0)
  } finally { await protocol.detach().catch(() => {}) }
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('普通笔荧光笔和形状支持45度吸附、撤销重做，导出PNG保持原分辨率与像素', async ({ page }) => {
  const { source, revision, read, writes, imagePath, originalPNG } = await prepare(page)
  await expect(page.getByRole('button', { name: '放大图片：示例图片', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true }), layer = dialog.locator('.image-annotation-layer')
  await expect(dialog.getByRole('button', { name: '原始尺寸', exact: true })).toBeEnabled()
  const mutations: string[] = []
  page.on('request', request => { if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(request.url()) })
  const stage = dialog.getByRole('region', { name: '图片缩放画布', exact: true })
  await stage.focus(); await page.keyboard.press('1'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown')
  await dialog.getByRole('button', { name: '普通笔', exact: true }).click()
  await dialog.getByLabel('笔宽（原图像素）').selectOption('12')
  await stroke(page, '普通笔', { x: 500, y: 400 }, { x: 900, y: 400 })
  await expect(layer).toHaveAttribute('data-mark-count', '1')
  await page.keyboard.press('ControlOrMeta+z'); await expect(layer).toHaveAttribute('data-mark-count', '0')
  await page.keyboard.press('ControlOrMeta+Shift+Z'); await expect(layer).toHaveAttribute('data-mark-count', '1')
  await stroke(page, '荧光笔', { x: 500, y: 550 }, { x: 900, y: 550 })
  await expect(layer.locator('path[data-tool="highlighter"]')).toHaveAttribute('opacity', '0.28')
  await stroke(page, '箭头', { x: 650, y: 280 }, { x: 850, y: 430 }, true)
  const arrow = (await layer.locator('path[data-tool="arrow"]').getAttribute('d'))!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number)
  expect(Math.abs(arrow[2] - arrow[0])).toBeCloseTo(Math.abs(arrow[3] - arrow[1]), 3)
  await stroke(page, '矩形', { x: 950, y: 450 }, { x: 1100, y: 530 }, true)
  const rectangle = (await layer.locator('path[data-tool="rectangle"]').getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  expect(Math.abs(rectangle[2] - rectangle[0])).toBeCloseTo(Math.abs(rectangle[5] - rectangle[1]), 3)
  await stroke(page, '直线', { x: 1000, y: 300 }, { x: 1200, y: 300 })
  await expect(layer).toHaveAttribute('data-mark-count', '5')
  const downloaded = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '导出标注', exact: true }).click()
  const file = await downloaded
  expect(await file.failure()).toBeNull(); expect(file.suggestedFilename()).toMatch(/-标注\.png$/)
  const png = (await readFile((await file.path())!)).toString('base64')
  const pixels = await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
    const sample = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data]
    const result = { width: image.width, height: image.height, pen: sample(700, 400), marker: sample(700, 550), untouched: sample(100, 900) }
    image.close(); canvas.width = 0; canvas.height = 0
    return result
  }, png)
  expect(pixels.width).toBe(1600); expect(pixels.height).toBe(1000)
  expect(pixels.pen).toEqual([239, 68, 68, 255])
  for (const [index, value] of [130, 130, 138, 255].entries()) expect(Math.abs(pixels.marker[index] - value)).toBeLessThanOrEqual(2)
  expect(pixels.untouched).toEqual([83, 101, 184, 255])
  const originalFile = await page.request.get(`/api/v1/files/download?path=${encodeURIComponent(imagePath)}`)
  expect(originalFile.status()).toBe(200)
  expect((await originalFile.body()).toString('base64')).toBe(originalPNG)
  expect(mutations).toEqual([])
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('整笔擦除和清空可撤销，关闭不询问且重新打开没有标注', async ({ page }) => {
  const { source, revision, read, writes } = await prepare(page)
  await expect(page.getByRole('button', { name: '放大图片：示例图片', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true }), layer = dialog.locator('.image-annotation-layer')
  await expect(dialog.getByRole('button', { name: '原始尺寸', exact: true })).toBeEnabled()
  await stroke(page, '普通笔', { x: 600, y: 400 }, { x: 1000, y: 400 })
  await stroke(page, '普通笔', { x: 600, y: 600 }, { x: 1000, y: 600 })
  await expect(layer).toHaveAttribute('data-mark-count', '2')
  await stroke(page, '橡皮擦（整笔）', { x: 800, y: 350 }, { x: 800, y: 650 })
  await expect(layer).toHaveAttribute('data-mark-count', '0')
  await dialog.getByRole('button', { name: '撤销标注', exact: true }).click()
  await expect(layer).toHaveAttribute('data-mark-count', '2')
  await dialog.getByRole('button', { name: '清空标注', exact: true }).click()
  await expect(layer).toHaveAttribute('data-mark-count', '0')
  await dialog.getByRole('button', { name: '撤销标注', exact: true }).click()
  await expect(layer).toHaveAttribute('data-mark-count', '2')
  const prompts: string[] = []
  page.on('dialog', prompt => { prompts.push(prompt.message()); void prompt.dismiss() })
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '原始尺寸', exact: true })).toBeEnabled()
  await expect(layer).toHaveAttribute('data-mark-count', '0')
  await expect(dialog.getByRole('button', { name: '移动图片', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByRole('button', { name: '导出标注', exact: true })).toBeDisabled()
  expect(prompts).toEqual([])
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('手机画笔支持单指标注，双指接管时取消未完成笔迹且保留已有标注', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { source, revision, read, writes } = await prepare(page)
  await expect(page.getByRole('button', { name: '放大图片：示例图片', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true }), layer = dialog.locator('.image-annotation-layer'), stage = dialog.locator('.image-preview-stage')
  await expect(dialog.getByRole('button', { name: '原始尺寸', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '普通笔', exact: true }).click()
  const box = (await stage.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2
  const protocol = await page.context().newCDPSession(page)
  try {
    await protocol.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x - 40, y }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x + 40, y }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(layer).toHaveAttribute('data-mark-count', '1')
    const path = await layer.locator('path').getAttribute('d'), initial = Number(await stage.getAttribute('data-scale'))
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x - 30, y }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x - 30, y }, { id: 2, x: x + 30, y }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x - 60, y }, { id: 2, x: x + 60, y }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => stage.evaluate(element => Number(element.dataset.scale))).toBeCloseTo(initial * 2, 2)
    await expect(layer).toHaveAttribute('data-mark-count', '1'); await expect(layer.locator('path')).toHaveAttribute('d', path!)
    await dialog.getByRole('button', { name: '适应窗口', exact: true }).click()
    const blankScale = Number(await stage.getAttribute('data-scale')), blankY = box.y + 120
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x - 30, y: blankY }, { id: 2, x: x + 30, y: blankY }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x - 60, y: blankY }, { id: 2, x: x + 60, y: blankY }] })
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => stage.evaluate(element => Number(element.dataset.scale))).toBeCloseTo(blankScale * 2, 2)
    await expect(layer).toHaveAttribute('data-mark-count', '1')
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
  } finally { await protocol.detach().catch(() => {}) }
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('导出编码失败明确提示且保留标注，可再次导出，不写原件或正文', async ({ page }) => {
  const { source, revision, read, writes } = await prepare(page)
  await expect(page.getByRole('button', { name: '放大图片：示例图片', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true })
  await expect(dialog.getByRole('button', { name: '原始尺寸', exact: true })).toBeEnabled()
  await stroke(page, '普通笔', { x: 600, y: 450 }, { x: 1000, y: 450 })
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      HTMLCanvasElement.prototype.toBlob = original
      queueMicrotask(() => callback(null))
    }
  })
  await dialog.getByRole('button', { name: '导出标注', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('PNG 编码失败')
  await expect(dialog.locator('.image-annotation-layer')).toHaveAttribute('data-mark-count', '1')
  const downloaded = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '导出标注', exact: true }).click()
  expect(await (await downloaded).failure()).toBeNull()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('快速抬笔补齐末端，原地切换Shift即时更新45度吸附', async ({ page }) => {
  const { source, revision, read, writes } = await prepare(page)
  await expect(page.getByRole('button', { name: '放大图片：示例图片', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '放大图片：示例图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true }), layer = dialog.locator('.image-annotation-layer')
  await expect(dialog.getByRole('button', { name: '原始尺寸', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '直线', exact: true }).click()
  let box = (await dialog.locator('img').boundingBox())!
  const protocol = await page.context().newCDPSession(page)
  try {
    await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + box.width * 0.4, y: box.y + box.height * 0.4, button: 'left', buttons: 1, clickCount: 1 })
    await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + box.width * 0.6, y: box.y + box.height * 0.55, button: 'left', buttons: 0, clickCount: 1 })
    await expect(layer).toHaveAttribute('data-mark-count', '1')
    const values = (await layer.locator('path').getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    expect(values[2] - values[0]).toBeCloseTo(320, 0); expect(values[3] - values[1]).toBeCloseTo(150, 0)
  } finally { await protocol.detach().catch(() => {}) }
  await dialog.getByRole('button', { name: '清空标注', exact: true }).click()
  box = (await dialog.locator('img').boundingBox())!
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4); await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55)
  const path = layer.locator('path')
  const delta = () => path.evaluate(element => {
    const values = element.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    return Math.abs(Math.abs(values[2] - values[0]) - Math.abs(values[3] - values[1]))
  })
  expect(await delta()).toBeGreaterThan(50)
  await page.keyboard.down('Shift'); await expect.poll(delta).toBeLessThan(0.01)
  await page.keyboard.up('Shift'); await expect.poll(delta).toBeGreaterThan(50)
  await page.keyboard.down('Shift'); await page.mouse.up(); await page.keyboard.up('Shift')
  await expect(layer).toHaveAttribute('data-mark-count', '1'); expect(await delta()).toBeLessThan(0.01)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})
