import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

for (const mode of ['富文本', '源码']) {
  test(`${mode}粘贴和拖入图片上传到笔记目录，Ctrl 点击引用打开文件`, async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
    await page.getByRole('button', { name: '进入工作区' }).click()
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
    const me = await (await page.request.get('/api/v1/auth/me')).json()
    const headers = { 'X-CSRF-Token': me.csrfToken }, folder = `引用-${mode}-${Date.now()}`
    expect((await page.request.post('/api/v1/directories', { headers, data: { path: folder } })).ok()).toBe(true)
    const note = `${folder}/笔记.md`, target = `${folder}/目标 中文.json`
    const original = '[打开目标](./目标%20中文.json)\n'
    for (const [path, content] of [[note, original], [target, '{"保留":true}']]) {
      expect((await page.request.post('/api/v1/files', { headers, data: { path, content } })).status()).toBe(201)
    }
    await page.getByRole('button', { name: '刷新文件列表' }).click()
    await page.getByRole('button', { name: folder, exact: true }).click()
    await page.getByRole('button', { name: '笔记.md', exact: true }).click()
    if (mode === '源码') await page.getByRole('button', { name: '源码', exact: true }).click()
    const editor = page.getByRole('textbox', { name: mode === '源码' ? '源码编辑器' : 'Markdown 富文本编辑器' })
    const link = mode === '源码' ? editor.locator('.cm-line').first() : editor.locator('a').first()
    await link.click({ position: { x: 30, y: 8 } })
    await expect(page.getByRole('tab', { name: '目标 中文.json', exact: true })).toHaveCount(0)
    await link.click({ modifiers: ['Control'], position: { x: 30, y: 8 } })
    await expect(page.getByRole('textbox', { name: '源码编辑器' })).toContainText('{"保留":true}')
    await page.getByRole('tab', { name: '笔记.md', exact: true }).click()
    await link.click({ modifiers: ['Meta'], position: { x: 30, y: 8 } })
    await expect(page.getByRole('textbox', { name: '源码编辑器' })).toContainText('{"保留":true}')
    await page.getByRole('tab', { name: '笔记.md', exact: true }).click()
    const png = [...await readFile(fileURLToPath(new URL('../fixtures/preview.png', import.meta.url)))]
    for (const action of ['paste', 'drop']) {
      await editor.click(); await page.keyboard.press('Control+End')
      await editor.evaluate((element, { png, action }) => {
        const transfer = new DataTransfer()
        transfer.items.add(new File([new Uint8Array(png)], `${action}.png`, { type: 'image/png' }))
        const box = element.getBoundingClientRect()
        const event = action === 'paste' ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }) : new DragEvent('drop', { dataTransfer: transfer, clientX: box.x + 40, clientY: box.y + 20, bubbles: true, cancelable: true })
        element.dispatchEvent(event)
      }, { png, action })
      await expect(page.locator('.save-status')).toHaveText('已保存')
      const url = `/api/v1/files/content?path=${encodeURIComponent(note)}`
      await expect.poll(async () => (await (await page.request.get(url)).json()).content).toContain(`![${action}.png](./image-`)
    }
    const content = (await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(note)}`)).json()).content as string
    expect(content).not.toContain('/api/')
    const images = [...content.matchAll(/\.\/(image-[^)]+)\)/g)]
    expect(images).toHaveLength(2)
    for (const image of images) expect((await page.request.get(`/api/v1/files/download?path=${encodeURIComponent(`${folder}/${image[1]}`)}`)).status()).toBe(200)
    if (mode === '源码') {
      await editor.locator('.cm-line').filter({ hasText: 'paste.png' }).click({ modifiers: ['Control'], position: { x: 30, y: 8 } })
      await expect(page.locator('.image-viewer img')).toBeVisible()
      await page.getByRole('tab', { name: '笔记.md', exact: true }).click()
      await page.getByRole('button', { name: '富文本', exact: true }).click()
    }
    await page.locator('.folio-markdown-image').first().click({ modifiers: ['Control'] })
    await expect(page.locator('.image-viewer img')).toBeVisible()
  })
}

test('图片上传失败保留原件，重试后补回原笔记', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  await page.getByRole('button', { name: '新建笔记', exact: true }).first().click()
  const name = `失败重试-${Date.now()}.md`
  await page.getByLabel('名称', { exact: true }).fill(name)
  await page.getByRole('button', { name: '创建', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await editor.fill('保留正文')
  await page.route('**/api/v1/uploads?**', route => route.fulfill({ status: 500, json: { error: { code: 'test_failure', message: '测试上传失败' } } }))
  const png = [...await readFile(fileURLToPath(new URL('../fixtures/preview.png', import.meta.url)))]
  await editor.evaluate((element, png) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(png)], '失败.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, png)
  await expect(page.locator('.upload-failure')).toContainText('测试上传失败')
  await expect(editor).toContainText('保留正文')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: /下载待上传原件/ }).click()
  expect([...await readFile((await (await download).path())!)]).toEqual(png)
  await page.unroute('**/api/v1/uploads?**')
  await page.getByRole('button', { name: '重试到当前目录' }).click()
  await expect(page.locator('.upload-failure')).toHaveCount(0)
  await expect.poll(async () => (await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()).content).toContain('![失败.png](./image-')
})
