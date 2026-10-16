import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const firstLineInsert = (source: string, text: string) => { const index = source.search(/\r\n|\r|\n/); return source.slice(0, index) + text + source.slice(index) }
async function prepare(page: Page, name: string, content: string) {
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path: name, content } })).status()).toBe(201)
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name, exact: true }).click()
  if (name.endsWith('.md')) await page.getByRole('dialog', { name: '富文本转换预览' }).getByRole('button', { name: '保留原文，使用源码' }).click()
  await expect(page.getByRole('textbox', { name: '源码编辑器' })).toBeVisible()
}
async function login(page: Page) {
  page.on('dialog', (dialog) => void dialog.accept())
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
}
async function assertDisk(page: Page, name: string, expected: string) {
  await expect(page.locator('.save-status')).toHaveText('已保存')
  expect((await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()).content).toBe(expected)
  const root = (await readFile(resolve('../artifacts/browser-workspace-path'), 'utf8')).trim()
  expect(await readFile(join(root, name))).toEqual(Buffer.from(expected))
}

test('CRLF、CR 与混合换行在编辑、撤销/重做、换行和切换文件后保留原始字节', async ({ page }) => {
  await login(page)
  const suffix = Date.now()
  for (const [kind, original] of [['CRLF', '\ufeff# 标题\r\n\r\n正文\r\n'], ['CR', '甲\r乙\r'], ['混合', '甲\r\n乙\n丙\r丁\r\n']]) {
    const name = `${kind}-${suffix}.${kind === 'CRLF' ? 'md' : 'txt'}`
    await prepare(page, name, original)
    await assertDisk(page, name, original)
    const source = page.getByRole('textbox', { name: '源码编辑器' })
    await source.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('End'); await page.keyboard.insertText('X')
    await page.keyboard.press('Control+s')
    const edited = firstLineInsert(original, 'X')
    await assertDisk(page, name, edited)
    await page.keyboard.press('Control+z'); await page.keyboard.press('Control+s')
    await assertDisk(page, name, original)
    await page.keyboard.press(process.platform === 'win32' ? 'Control+y' : 'Control+Shift+z'); await page.keyboard.press('Control+s')
    await assertDisk(page, name, edited)
    await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.insertText('新行')
    await page.keyboard.press('Control+s')
    const appended = edited + /\r\n|\r|\n/.exec(original)![0] + '新行'
    await assertDisk(page, name, appended)
    const other = `${kind}-辅助-${suffix}.json`
    await prepare(page, other, '{}')
    await page.getByRole('tab', { name, exact: true }).click()
    await source.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('End'); await page.keyboard.insertText('Y'); await page.keyboard.press('Control+s')
    await assertDisk(page, name, firstLineInsert(appended, 'Y'))
  }
})

test('带混合换行的失败保存草稿经下载、刷新与显式恢复后仍保真', async ({ page }) => {
  await login(page)
  const name = `换行恢复-${Date.now()}.txt`, original = '甲\r\n乙\n丙\r丁\r\n'
  await prepare(page, name, original)
  await page.route('**/api/v1/files/content?**', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'test_offline', message: '测试保存中断' } }) }) : route.continue())
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await source.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('End'); await page.keyboard.insertText('X'); await page.keyboard.press('Control+s')
  const expected = firstLineInsert(original, 'X')
  await expect(page.locator('.save-status')).toContainText('保存失败')
  await expect(page.getByText('本机恢复副本已更新', { exact: true })).toBeVisible()
  let download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载当前草稿' }).click()
  expect(await readFile(await (await download).path()!)).toEqual(Buffer.from(expected))
  await page.reload()
  await page.getByRole('button', { name: '查看浏览器恢复稿' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button').filter({ hasText: name }).click()
  download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '下载恢复稿' }).click()
  expect(await readFile(await (await download).path()!)).toEqual(Buffer.from(expected))
  await dialog.getByRole('button', { name: '打开为待确认草稿' }).click()
  await expect(dialog).not.toBeVisible()
  expect((await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).json()).content).toBe(original)
  await page.unroute('**/api/v1/files/content?**')
  await source.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.press('End'); await page.keyboard.insertText('Y'); await page.keyboard.press('Control+s')
  await assertDisk(page, name, firstLineInsert(expected, 'Y'))
})
