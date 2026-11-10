import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function prepare(page: Page, source: string) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  const ready = page.waitForResponse(response => response.url().includes('/workspace/events?') && response.status() === 200)
  await page.getByRole('button', { name: '进入工作区' }).click(); await ready
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const path = `表格-${Date.now()}-${test.info().testId.slice(-5)}.md`
  const created = await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': me.csrfToken }, data: { path, content: source } })
  expect(created.status()).toBe(201)
  const revision = (await created.json()).revision as string
  const open = page.getByRole('button', { name: '展开文件列表', exact: true })
  if (await open.isVisible()) await open.click()
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name: path, exact: true }).click()
  const editor = page.locator('.source-host .cm-content')
  await expect(editor).toBeVisible()
  const writes: { content: string; match?: string }[] = []
  page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/files/content') writes.push({ content: request.postDataJSON().content, match: request.headers()['if-match'] }) })
  const read = async () => {
    const response = await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)
    const file = await response.json()
    expect(response.headers().etag).toBe(`"${file.revision}"`)
    return { content: file.content as string, revision: file.revision as string }
  }
  return { editor, read, writes, revision, path, csrf: me.csrfToken as string }
}
async function menu(page: Page, label: string) {
  await page.getByRole('button', { name: '表格', exact: true }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}
async function tail(page: Page) {
  const editor = page.locator('.source-host .cm-content')
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End')
}

test('普通正文末尾插表格，不删除文字；一次撤销恢复原始版本', async ({ page }) => {
  const source = '\ufeff# 标题\r\n\r\n正文。'
  const { editor, read, writes, revision } = await prepare(page, source)
  await tail(page)
  await menu(page, '插入新表格…')
  const dialog = page.getByRole('dialog', { name: '插入表格', exact: true })
  await dialog.getByLabel('正文行数').fill('2'); await dialog.getByLabel('列数').fill('3')
  await dialog.getByRole('button', { name: '插入', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await read()).content).toContain('列 3')
  const inserted = (await read()).content
  expect(inserted.startsWith(source)).toBe(true)
  expect(inserted).not.toMatch(/(?<!\r)\n/)
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0].match).toBe(`"${revision}"`)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(read).toEqual({ content: source, revision })
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect.poll(async () => (await read()).content).toBe(inserted)
})

test('行列和对齐只改目标片段，删除新行列及撤销恢复原文', async ({ page }) => {
  const source = '前言\r\n\r\n|  H1   | H2 |\n| :----- | -----: |\r|  A  | B |\n\n尾部。'
  const { editor, read } = await prepare(page, source)
  await tail(page)
  await page.locator('.folio-preview-table').getByRole('cell', { name: 'B', exact: true }).click()
  await menu(page, '右侧插入列')
  await expect.poll(async () => (await read()).content).toContain('新列')
  const added = (await read()).content
  expect(added.startsWith('前言\r\n\r\n|  H1   | H2 |')).toBe(true)
  expect(added.endsWith('\n\n尾部。')).toBe(true)
  await menu(page, '删除当前列')
  await expect.poll(async () => (await read()).content).toBe(source)
  await page.getByRole('button', { name: '表格', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '居中', exact: true }).click()
  await expect.poll(async () => (await read()).content).toBe(source.replace('-----:', ':-----:'))
  await tail(page)
  await expect(page.locator('.folio-preview-table th').nth(1)).toHaveCSS('text-align', 'center')
  await page.locator('.folio-preview-table').getByRole('cell', { name: 'B', exact: true }).click()
  await page.getByRole('button', { name: '表格', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '右对齐', exact: true }).click()
  await expect.poll(async () => (await read()).content).toBe(source)
  await menu(page, '下方插入行')
  await expect.poll(async () => (await read()).content.split('\r\n').length).toBeGreaterThan(source.split('\r\n').length)
  const row = (await read()).content
  await menu(page, '删除当前行')
  await expect.poll(async () => (await read()).content).toBe(source)
  await editor.focus(); await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await read()).content).toBe(row)
})

test('Tab与ShiftTab按单元格导航，首格可离开、末格新增行', async ({ page }) => {
  const source = '前言\n\n| H1 | H2 |\n| --- | --- |\n| A | B |\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  await tail(page)
  await page.locator('.folio-preview-table').getByRole('cell', { name: 'A', exact: true }).click()
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('B')
  for (const expected of ['A', 'H2', 'H1']) {
    await page.keyboard.press('Shift+Tab')
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(expected)
  }
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('button', { name: '表格', exact: true })).toBeFocused()
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
  await editor.focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('B')
  await page.keyboard.press('Tab')
  await page.keyboard.insertText('新值')
  await expect.poll(async () => (await read()).content).toContain('新值')
  expect((await read()).content.endsWith('\n\n尾部。')).toBe(true)
  await tail(page)
  await expect(page.locator('.folio-preview-table td')).toHaveCount(4)
})

test('插表窗口取消或非法尺寸不写入，明暗手机可用', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  const source = '原文。'
  const { read, writes, revision } = await prepare(page, source)
  await tail(page); await menu(page, '插入新表格…')
  const dialog = page.getByRole('dialog', { name: '插入表格', exact: true })
  for (const value of ['0', '21', '1.5', '']) {
    await dialog.getByLabel('列数').fill(value)
    await dialog.getByRole('button', { name: '插入', exact: true }).click()
    await expect(dialog).toBeVisible()
    expect(writes).toEqual([])
  }
  await dialog.getByLabel('列数').fill('2')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('button', { name: '表格', exact: true })).toBeFocused()
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('插表期间外部改稿会关闭旧窗口，不把旧选区写到新版本', async ({ page }) => {
  const { path, read, writes, revision, csrf } = await prepare(page, '原文。')
  await tail(page); await menu(page, '插入新表格…')
  await expect(page.getByRole('dialog', { name: '插入表格', exact: true })).toBeVisible()
  const updated = await page.request.put(`/api/v1/files/content?path=${encodeURIComponent(path)}`, { headers: { 'X-CSRF-Token': csrf, 'If-Match': `"${revision}"` }, data: { content: '外部新版本。' } })
  expect(updated.status()).toBe(200)
  await expect(page.getByRole('dialog', { name: '插入表格', exact: true })).toBeHidden()
  expect((await read()).content).toBe('外部新版本。')
  expect(writes).toEqual([])
})

test('单元格中的原生IME候选暂停保存，Tab不抢候选，确认取消均保留其他格', async ({ page }) => {
  const source = '| H1 | H2 |\n| --- | --- |\n| A | B |\n\n尾部。'
  const { editor, read, writes, revision } = await prepare(page, source)
  await tail(page)
  await page.locator('.folio-preview-table').getByRole('cell', { name: 'A', exact: true }).click()
  await page.keyboard.press('ArrowRight')
  const protocol = await page.context().newCDPSession(page)
  try {
    await protocol.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
    await expect(page.getByRole('button', { name: '表格', exact: true })).toBeDisabled()
    await editor.dispatchEvent('keydown', { key: 'Tab', isComposing: true, keyCode: 229 })
    await page.waitForTimeout(1200)
    expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
    await protocol.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await expect(page.locator('.save-status')).toHaveText('已保存')
    expect(await read()).toEqual({ content: source, revision })
    await protocol.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
    await protocol.send('Input.insertText', { text: '中文' })
    await expect.poll(async () => (await read()).content).toBe(source.replace('| A |', '| A中文 |'))
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0].match).toBe(`"${revision}"`)
  } finally { await protocol.detach().catch(() => {}) }
})
