import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

const password = 'folio-browser-test-password-2026'
async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
}
async function create(page: Page, kind: '笔记' | '文件夹', name: string) {
  await page.getByRole('button', { name: `新建${kind}`, exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('名称', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).not.toBeVisible()
}

test('真实目录、Markdown 与 JSON 自动保存，刷新后重新读取', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)
  const folder = `日常笔记-${Date.now()}`
  await create(page, '文件夹', folder)
  await create(page, '笔记', '第一篇.md')
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await rich.fill('中文正文，保存到真实文件。')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await create(page, '笔记', '配置.json')
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await source.fill('{"独立":true}')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  await page.getByRole('tab', { name: '第一篇.md' }).click()
  await expect(rich).toContainText('中文正文，保存到真实文件。')
  await page.reload()
  await expect(page.getByRole('button', { name: folder, exact: true })).toBeVisible()
  await page.getByRole('button', { name: folder, exact: true }).click()
  await page.getByRole('button', { name: '第一篇.md', exact: true }).click()
  await expect(rich).toContainText('中文正文，保存到真实文件。')
  await page.screenshot({ path: 'test-results/real-workspace-1440.png' })
  await page.getByRole('button', { name: '配置.json', exact: true }).click()
  await expect(source).toContainText('{"独立":true}')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '收起文件列表' }).click()
  await page.screenshot({ path: 'test-results/real-workspace-390.png' })
})

test('陈旧版本冲突可比较并另存本地副本，原磁盘版本不覆盖', async ({ page }) => {
  await login(page)
  const name = `冲突-${Date.now()}.md`
  await create(page, '笔记', name)
  await page.getByRole('button', { name: '源码', exact: true }).click()
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  const file = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const remoteSave = await page.request.put(`/api/v1/files/content?path=${encodeURIComponent(name)}`, { headers: { 'X-CSRF-Token': principal.csrfToken, 'If-Match': `"${file.revision}"` }, data: { content: '# 其他编辑器的新内容\n' } })
  expect(remoteSave.status()).toBe(200)
  await source.fill('我的本地草稿')
  await page.getByRole('button', { name: '保存当前文件' }).click()
  await expect(page.locator('.save-status')).toContainText('版本冲突')
  await expect(source).toContainText('我的本地草稿')
  await page.getByRole('button', { name: '比较版本' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('磁盘版本')).toHaveValue('# 其他编辑器的新内容\n')
  await dialog.getByRole('button', { name: '保留本地副本并加载磁盘版本' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(source).toContainText('我的本地草稿')
  const latest = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()
  expect(latest.content).toBe('# 其他编辑器的新内容\n')
})
