import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFile, writeFile, rename, mkdir, stat, utimes } from 'node:fs/promises'
import { resolve, join } from 'node:path'

async function prepare(page: Page, nested = false) {
  const root = (await readFile(resolve('../artifacts/browser-workspace-path'), 'utf8')).trim()
  const name = `外部修改-${Date.now()}`
  const path = nested ? `${name}/笔记.md` : `${name}.md`
  if (nested) await mkdir(join(root, name))
  await writeFile(join(root, path), '# 初始内容\n')
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  if (nested) await page.getByRole('button', { name, exact: true }).click()
  await page.getByRole('button', { name: nested ? '笔记.md' : path, exact: true }).click()
  await page.getByRole('button', { name: '源码', exact: true }).click()
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await expect(source).toContainText('初始内容')
  return { root, path, name, source }
}

test('真实磁盘同大小同 mtime 改写会提示，显式加载后显示新版本', async ({ page }) => {
  const { root, path, source } = await prepare(page)
  const before = await stat(join(root, path))
  await writeFile(join(root, path), '# 磁盘改写\n')
  await utimes(join(root, path), before.atime, before.mtime)
  await expect(page.getByRole('button', { name: '加载磁盘版本', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(source).toContainText('初始内容')
  await page.getByRole('button', { name: '加载磁盘版本', exact: true }).click()
  await expect(source).toContainText('磁盘改写')
  await expect(page.locator('.save-status')).toHaveText('已保存')
  expect(await readFile(join(root, path), 'utf8')).toBe('# 磁盘改写\n')
  await page.route('**/api/v1/files/revision?**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: '测试检查失败' } }) }))
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await expect(page.getByText('部分文件的磁盘变更检查失败，当前正文已保留，请重试。', { exact: true })).toBeVisible()
  await expect(source).toContainText('磁盘改写')
  await page.unroute('**/api/v1/files/revision?**')
  await page.getByRole('button', { name: '重新检查', exact: true }).click()
  await expect(page.getByRole('button', { name: '重新检查', exact: true })).not.toBeVisible()
})

test('外部改写后的脏缓冲区停止保存，另存副本保留两份正文', async ({ page }) => {
  const { root, path, source } = await prepare(page)
  await writeFile(join(root, path), '# 外部编辑器的新版本\n')
  await source.fill('尚未保存的本地草稿')
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await expect(page.locator('.save-status')).toContainText('版本冲突')
  await expect(source).toContainText('尚未保存的本地草稿')
  await page.getByRole('button', { name: '比较版本', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('磁盘版本')).toHaveValue('# 外部编辑器的新版本\n')
  await page.screenshot({ path: 'test-results/external-conflict.png' })
  const copy = await dialog.getByLabel('副本路径').inputValue()
  await dialog.getByRole('button', { name: '保留本地副本并加载磁盘版本' }).click()
  await expect(dialog).not.toBeVisible()
  expect(await readFile(join(root, copy), 'utf8')).toBe('尚未保存的本地草稿')
  expect(await readFile(join(root, path), 'utf8')).toBe('# 外部编辑器的新版本\n')
})

test('目录被外部移走时保留脏草稿，可改到存在的目录另存', async ({ page }) => {
  const { root, path, name, source } = await prepare(page, true)
  await rename(join(root, name), join(root, `${name}-移走`))
  await source.fill('目录消失仍能找回的草稿')
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await expect(page.locator('.save-status')).toContainText('版本冲突')
  await expect(page.getByRole('button', { name: `${name}-移走`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: '比较版本', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const saveCopy = dialog.getByRole('button', { name: '另存本地副本', exact: true })
  await expect(saveCopy).toBeEnabled()
  await saveCopy.click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(dialog.getByLabel('本地草稿', { exact: true })).toHaveValue('目录消失仍能找回的草稿')
  const copy = `恢复-${name}.md`
  await dialog.getByLabel('副本路径').fill(copy)
  await saveCopy.click()
  await expect(dialog).not.toBeVisible()
  await expect(source).toContainText('目录消失仍能找回的草稿')
  expect(await readFile(join(root, copy), 'utf8')).toBe('目录消失仍能找回的草稿')
  expect(await readFile(join(root, `${name}-移走/笔记.md`), 'utf8')).toBe('# 初始内容\n')
  await expect(page.getByRole('tab', { name: path.split('/').at(-1), exact: true })).toHaveCount(0)
})
