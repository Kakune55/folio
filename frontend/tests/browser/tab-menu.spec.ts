import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function setup(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const id = Date.now(), names = ['a', 'b', 'c'].map((part) => `${part}-标签-${id}.txt`)
  for (const name of names) expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path: name, content: `${name} 正文` } })).status()).toBe(201)
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  const open = async (name: string) => {
    await page.getByRole('button', { name, exact: true }).click()
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('textbox', { name: '源码编辑器' })).toBeVisible()
  }
  for (const name of names) await open(name)
  const action = async (name: string, label: string) => {
    await page.getByRole('tab', { name: new RegExp(name) }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }
  return { names, open, action }
}

test('标签右键以目标标签为基准关闭右侧、其他、单个和全部，磁盘文件保留', async ({ page }) => {
  const { names: [a,b,c], open, action } = await setup(page)
  await action(b, '关闭右侧标签页')
  await expect(page.getByRole('tab')).toHaveCount(2)
  await expect(page.getByRole('tab', { name: c, exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: b, exact: true })).toHaveAttribute('aria-selected', 'true')
  await open(c)
  await action(b, '关闭其他')
  await expect(page.getByRole('tab')).toHaveCount(1)
  await expect(page.getByRole('tab', { name: b, exact: true })).toBeFocused()
  await action(b, '关闭')
  await expect(page.getByRole('tab')).toHaveCount(0)
  await open(a); await open(b); await open(c)
  await action(a, '关闭所有')
  await expect(page.getByRole('tab')).toHaveCount(0)
  for (const name of [a,b,c]) expect((await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).status()).toBe(200)
})

test('关闭已保存跳过草稿，批量关闭失败保留标签和正文，恢复保存后可关闭', async ({ page }) => {
  const { names: [a,b,c], open, action } = await setup(page)
  await open(b)
  await page.route('**/api/v1/files/content?**', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 503, json: { error: { code: 'test', message: '模拟磁盘故障' } } }) : route.continue())
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await source.press('Control+End'); await page.keyboard.insertText('尚未保存的追加内容')
  await expect(page.locator('.save-status')).toContainText('保存失败')
  await action(a, '关闭已保存')
  await expect(page.getByRole('tab')).toHaveCount(1)
  await expect(page.getByRole('tab')).toContainText(b)
  await expect(source).toContainText('尚未保存的追加内容')
  await open(c)
  await action(c, '关闭所有')
  await expect(page.getByText('1 个标签页因保存失败、冲突或未完成操作而保留，请处理后重试。')).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(1)
  await expect(source).toContainText('尚未保存的追加内容')
  const remote = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(b)}`)).json()
  expect(remote.content).not.toContain('尚未保存的追加内容')
  await page.unroute('**/api/v1/files/content?**')
  await action(b, '关闭所有')
  await expect(page.getByRole('tab')).toHaveCount(0)
  const saved = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(b)}`)).json()
  expect(saved.content).toContain('尚未保存的追加内容')
  expect((await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(c)}`)).status()).toBe(200)
})

test('标签菜单键盘打开、禁用边界、Escape 焦点返回与明暗可访问性', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { names: [, , c] } = await setup(page)
  const tab = page.getByRole('tab', { name: c, exact: true })
  await tab.focus(); await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: '标签页操作' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '关闭右侧标签页', exact: true })).toBeDisabled()
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(result.violations).toEqual([])
  }
  await page.keyboard.press('Escape')
  await expect(tab).toBeFocused()
})
