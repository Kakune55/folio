import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

async function setup(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const headers = { 'X-CSRF-Token': principal.csrfToken }
  const create = async (path: string, directory = false, content = '# 原始正文\n') => {
    expect((await page.request.post(`/api/v1/${directory ? 'directories' : 'files'}`, { headers, data: directory ? { path } : { path, content } })).status()).toBe(201)
  }
  const file = async (path: string) => (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)).json()
  const row = (path: string) => page.locator(`button[data-entry-path=${JSON.stringify(path)}]`)
  return { create, file, row, name: `交互-${Date.now()}` }
}

test('真实鼠标拖拽移动文件及目录，脏正文保存后使用新路径', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const { create, file, row, name } = await setup(page)
  const folder = `${name}-目标`, parent = `${name}-父目录`, note = `${name}.md`
  await create(folder, true); await create(parent, true); await create(note)
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await row(note).click()
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await rich.fill('拖拽前的最后一笔输入')
  await row(note).dragTo(row(folder))
  await expect(page.locator('.breadcrumb')).toContainText(`${folder}/${note}`)
  expect((await file(`${folder}/${note}`)).content).toContain('拖拽前的最后一笔输入')
  await row(folder).dragTo(row(parent))
  await expect(page.locator('.breadcrumb')).toContainText(`${parent}/${folder}/${note}`)
  await rich.fill('目录移动后继续输入')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  expect((await file(`${parent}/${folder}/${note}`)).content).toContain('目录移动后继续输入')
  await row(`${parent}/${folder}`).dragTo(page.locator('[data-entry-path=""]'))
  await expect(page.locator('.breadcrumb')).toContainText(`${folder}/${note}`)
  expect((await file(`${folder}/${note}`)).content).toContain('目录移动后继续输入')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  const markdown = await page.evaluate(async (source) => {
    // 视觉样本采用当前 Crepe 的序列化格式；兼容性判断另有独立的固定原文语料。
    // @ts-expect-error 由 Vite 提供浏览器模块。
    const { inspectRoundTrip } = await import('/src/editors/milkdown/engine.ts')
    return (await inspectRoundTrip(source)).serialized as string
  }, '# 工作流验收\n\n中文正文与 `request_id`。\n\n> 变更有迹可循。\n\n| 文件 | 状态 |\n| -- | -- |\n| 笔记 | 已保存 |\n\n```json\n{"ready":true}\n```\n')
  await page.getByRole('textbox', { name: '源码编辑器' }).fill(markdown)
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await page.getByRole('button', { name: '富文本', exact: true }).click()
  await expect(rich.getByRole('heading', { name: '工作流验收' })).toBeVisible()
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 1024 ? 768 : 900 })
    if (width === 390) await page.getByRole('button', { name: '收起文件列表' }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/workflow-${width}-light.png` })
    await page.getByRole('button', { name: '主题：跟随系统', exact: true }).click()
    await page.getByRole('button', { name: '主题：浅色', exact: true }).click()
    await page.screenshot({ path: `test-results/workflow-${width}-dark.png` })
    await page.getByRole('button', { name: '主题：深色', exact: true }).click()
  }
})

test('拖拽重名不覆盖，原位和子目录拒绝移动，外部伪造拖拽不执行路径操作', async ({ page }) => {
  const { create, file, row, name } = await setup(page)
  const folder = `${name}-目录`, child = `${folder}/子目录`, note = `${name}.md`
  await create(folder, true); await create(child, true); await create(note, false, '源文件'); await create(`${folder}/${note}`, false, '目标原文')
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await row(note).dragTo(row(folder))
  await expect(page.getByText('同名文件或目录已存在', { exact: true })).toBeVisible()
  expect((await file(note)).content).toBe('源文件')
  expect((await file(`${folder}/${note}`)).content).toBe('目标原文')
  await expect(row(note)).toHaveAttribute('draggable', 'true')
  let mutations = 0
  page.on('request', (request) => { if (request.method() === 'PATCH' && request.url().includes('/entries/move')) mutations++ })
  // 碰撞时目标目录已展开；把父目录拖入子目录或文件拖回原位均不发请求。
  const local = await page.evaluateHandle(() => new DataTransfer())
  await row(folder).dispatchEvent('dragstart', { dataTransfer: local })
  await row(child).dispatchEvent('dragover', { dataTransfer: local })
  await expect(row(child)).not.toHaveClass(/drop-target/)
  await row(child).dispatchEvent('drop', { dataTransfer: local })
  await row(folder).dispatchEvent('dragend', { dataTransfer: local })
  await row(note).dispatchEvent('dragstart', { dataTransfer: local })
  await page.locator('[data-entry-path=""]').dispatchEvent('dragover', { dataTransfer: local })
  await expect(page.locator('[data-entry-path=""]')).not.toHaveClass(/drop-target/)
  await page.locator('[data-entry-path=""]').dispatchEvent('drop', { dataTransfer: local })
  await row(note).dispatchEvent('dragend', { dataTransfer: local })
  const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); data.setData('application/x-folio-entry', '../outside'); return data })
  await row(folder).dispatchEvent('dragover', { dataTransfer: transfer })
  await row(folder).dispatchEvent('drop', { dataTransfer: transfer })
  expect(mutations).toBe(0)
})

test('键盘浏览、重命名、菜单移动及标签快捷键，保存冲突时拒绝关闭', async ({ page }) => {
  const { create, row, file, name } = await setup(page)
  const folder = `${name}-键盘目录`, note = `${folder}/键盘.json`, other = `${name}-另一个.md`
  await create(folder, true); await create(note, false, '{}'); await create(other)
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await row(folder).focus(); await page.keyboard.press('ArrowRight')
  await expect(row(note)).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(row(note)).toBeFocused()
  await page.keyboard.press('F2')
  const input = page.getByRole('textbox', { name: '重命名 键盘.json', exact: true })
  await input.fill('配置.json'); await input.press('Enter')
  const renamed = `${folder}/配置.json`
  await expect(row(renamed)).toBeVisible()
  await row(renamed).focus(); await page.keyboard.press('Shift+F10')
  await page.getByRole('menuitem', { name: '移动到…', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('目标路径').fill(`${name}-配置.json`)
  await dialog.getByRole('button', { name: '移动', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await row(`${name}-配置.json`).click()
  await expect(page.getByRole('tab', { name: `${name}-配置.json`, exact: true })).toBeVisible()
  await row(other).click()
  await expect(page.getByRole('tab', { name: other, exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Alt+PageUp')
  await expect(page.getByRole('tab', { name: `${name}-配置.json`, exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Alt+PageDown')
  await expect(page.getByRole('tab', { name: other, exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Alt+PageUp'); await page.keyboard.press('Control+Alt+w')
  await expect(page.getByRole('tab', { name: `${name}-配置.json`, exact: true })).not.toBeVisible()
  const remote = await file(other), principal = await (await page.request.get('/api/v1/auth/me')).json()
  expect((await page.request.put(`/api/v1/files/content?path=${encodeURIComponent(other)}`, { headers: { 'X-CSRF-Token': principal.csrfToken, 'If-Match': `"${remote.revision}"` }, data: { content: '其他版本' } })).status()).toBe(200)
  await page.getByRole('textbox', { name: 'Markdown 富文本编辑器' }).fill('我的草稿')
  await page.keyboard.press('Control+Alt+w')
  await expect(page.locator('.save-status')).toContainText('版本冲突')
  await expect(page.getByRole('tab', { name: other })).toBeVisible()
  await page.getByRole('button', { name: '查看快捷键' }).click()
  await expect(page.getByRole('heading', { name: '工作区快捷键' })).toBeVisible()
  await page.screenshot({ path: 'test-results/workflow-shortcuts-light.png' })
  await page.keyboard.press('Control+p')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.keyboard.press('Escape')
})
