import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

for (const mode of ['富文本', '源码']) {
  test(`${mode}侧栏真实拖拽插入引用，不移动或重新上传文件`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
    await page.getByRole('button', { name: '进入工作区' }).click()
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
    const me = await (await page.request.get('/api/v1/auth/me')).json(), headers = { 'X-CSRF-Token': me.csrfToken }
    const id = `${mode}-${Date.now()}`, folder = `笔记目录-${id}`, note = `${folder}/记录.md`, target = `目标 中文-${id}.json`, image = `图 [1]-${id}.png`
    expect((await page.request.post('/api/v1/directories', { headers, data: { path: folder } })).ok()).toBe(true)
    for (const [path, content] of [[note, '保留原有正文\n'], [target, '{"原件":true}']]) expect((await page.request.post('/api/v1/files', { headers, data: { path, content } })).ok()).toBe(true)
    const png = await readFile(fileURLToPath(new URL('../fixtures/preview.png', import.meta.url)))
    await page.getByLabel('上传附件文件').setInputFiles({ name: image, mimeType: 'image/png', buffer: png })
    const row = (path: string) => page.getByRole('button', { name: path, exact: true })
    await expect(row(image)).toBeVisible()
    await page.getByRole('button', { name: '刷新文件列表' }).click()
    await row(folder).click(); await row('记录.md').click()
    if (mode === '源码') await page.getByRole('button', { name: '源码', exact: true }).click()
    const editor = page.getByRole('textbox', { name: mode === '源码' ? '源码编辑器' : 'Markdown 富文本编辑器' })
    await expect(editor).toContainText('保留原有正文')
    let uploads = 0, moves = 0
    page.on('request', request => { if (request.url().includes('/uploads?')) uploads++; if (request.url().includes('/entries/move')) moves++ })
    for (const path of [target, image]) {
      await row(path).dragTo(editor, { targetPosition: { x: 60, y: 16 } })
      await expect.poll(async () => (await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(note)}`)).json()).content).toContain(encodeURIComponent(path).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    }
    const content = (await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(note)}`)).json()).content as string
    expect(content.replace(/!?\[(?:\\.|[^\]\\])*\]\([^)]+\)/g, '')).toContain('保留原有正文')
    expect(content).toContain('](../')
    expect(content).toContain('![')
    expect(uploads).toBe(0); expect(moves).toBe(0)
    expect((await page.request.get(`/api/v1/files/download?path=${encodeURIComponent(image)}`)).status()).toBe(200)
    expect((await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(target)}`)).json()).content).toBe('{"原件":true}')
    const before = content
    await row(folder).dragTo(editor, { targetPosition: { x: 60, y: 16 } })
    await expect(page.getByText('请拖入文件，暂不支持插入目录引用。', { exact: true })).toBeVisible()
    // 伪造 MIME 但没有本页面的活动手势，不能插入任意路径。
    await editor.evaluate(element => {
      const transfer = new DataTransfer(); transfer.setData('application/x-folio-entry', '../../伪造文件.md')
      element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
    })
    expect((await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(note)}`)).json()).content).toBe(before)
    await editor.dispatchEvent('dragleave')
    await page.getByRole('button', { name: mode === '源码' ? '富文本' : '源码', exact: true }).click()
    await page.getByRole('button', { name: mode, exact: true }).click()
    await expect(editor).toBeVisible()
    await page.waitForTimeout(80) // 覆盖拖放指示器卸载后的延迟回调窗口。
    expect(errors).toEqual([])
    expect(uploads).toBe(0); expect(moves).toBe(0)
  })
}
