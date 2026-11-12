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
  const editor = page.locator('.source-host > .cm-editor > .cm-scroller > .cm-content')
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
  const editor = page.locator('.source-host > .cm-editor > .cm-scroller > .cm-content')
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
  const { read, writes, revision } = await prepare(page, source)
  await tail(page)
  await page.locator('.folio-preview-table').getByRole('cell', { name: 'A', exact: true }).click()
  await page.keyboard.press('ArrowRight')
  const protocol = await page.context().newCDPSession(page)
  try {
    await protocol.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
    await expect(page.getByRole('button', { name: '表格', exact: true })).toBeDisabled()
    await page.locator('.folio-table-active .cm-content').dispatchEvent('keydown', { key: 'Tab', isComposing: true, keyCode: 229 })
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) await page.locator('.folio-table-active .cm-content').dispatchEvent('keydown', { key, isComposing: true, keyCode: 229 })
    await expect(page.locator('.folio-table-active .cm-content')).toHaveAttribute('aria-label', '表格第 1 行，第 1 列')
    await expect(page.locator('.folio-preview-table table')).toBeVisible()
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

test('单元格直接编辑保持表格外观、padding和混合换行，撤销模式切换不丢字', async ({ page }) => {
  const source = '\ufeff前言\r\n\r\n| H1 | H2 |\n| :--- | ---: |\r|  A  | B |\n\n尾部。'
  const { read, writes, revision } = await prepare(page, source)
  await tail(page)
  await page.getByRole('cell', { name: 'A', exact: true }).click()
  const input = page.locator('.folio-table-active .cm-content')
  await expect(input).toBeFocused()
  await page.keyboard.insertText('新')
  await page.keyboard.insertText(' ')
  await page.keyboard.insertText('值')
  await expect(input).toHaveText('新 值')
  await expect(page.locator('.folio-preview-table table')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'B', exact: true })).toBeVisible()
  const changed = source.replace('|  A  |', '|  新 值  |')
  await expect.poll(async () => (await read()).content).toBe(changed)
  await expect.poll(() => writes.length).toBeGreaterThan(0)
  expect(writes[0].match).toBe(`"${revision}"`)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await read()).content).toBe(source)
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect.poll(async () => (await read()).content).toBe(changed)
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(page.locator('.folio-preview-table')).toHaveCount(0)
  await page.getByRole('button', { name: '实时预览', exact: true }).click()
  await expect(page.locator('.folio-preview-table table')).toBeVisible()
  await page.getByRole('cell', { name: 'B', exact: true }).click()
  await page.keyboard.press('Backspace')
  await expect(page.locator('.folio-preview-table table')).toBeVisible()
  await expect.poll(async () => (await read()).content).toBe(changed.replace('| B |', '|  |'))
  await page.keyboard.press('Escape')
  await expect(page.locator('.folio-table-active')).toHaveCount(0)
})

test('手机明暗单元格编辑及不支持粘贴明确拒绝，原文和版本不变', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  const source = '前言\n\n| H1 | H2 |\n| --- | --- |\n| A | B |\n\n尾部。'
  const { read, writes, revision } = await prepare(page, source)
  await tail(page)
  await page.getByRole('cell', { name: 'A', exact: true }).click()
  const input = page.locator('.folio-table-active .cm-content')
  for (const value of ['a|b', 'a\nb', 'a\tb']) {
    await page.keyboard.insertText(value)
    await expect(input).toHaveText('A')
    await expect(page.getByText(/单元格.*源码/).first()).toBeVisible()
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    await expect(page.locator('.folio-preview-table table')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
  }
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('外部版本更新后旧单元格失效，不能继续写入旧位置', async ({ page }) => {
  const source = '前言\n\n| H1 | H2 |\n| --- | --- |\n| A | B |\n\n尾部。'
  const { read, writes, revision, path, csrf } = await prepare(page, source)
  await tail(page)
  await page.getByRole('cell', { name: 'A', exact: true }).click()
  const previous = await page.locator('.folio-table-active .cm-content').elementHandle()
  const next = source.replace('| A |', '| 外部值 |')
  const updated = await page.request.put(`/api/v1/files/content?path=${encodeURIComponent(path)}`, { headers: { 'X-CSRF-Token': csrf, 'If-Match': `"${revision}"` }, data: { content: next } })
  expect(updated.status()).toBe(200)
  await expect.poll(async () => previous!.evaluate(element => element.isConnected)).toBe(false)
  expect((await read()).content).toBe(next)
  expect(writes).toEqual([])
})

test('编辑表格外正文后返回原活动单元格可继续输入', async ({ page }) => {
  const source = '前言\n\n| H1 | H2 |\n| --- | --- |\n| A | B |\n\n尾部。'
  const { read } = await prepare(page, source)
  await tail(page)
  await page.getByRole('cell', { name: 'A', exact: true }).click()
  await page.keyboard.insertText('XYZ')
  await page.locator('.source-host > .cm-editor > .cm-scroller > .cm-content > .cm-line').filter({ hasText: '尾部。' }).click()
  await page.keyboard.press('End'); await page.keyboard.insertText('!')
  await page.getByRole('cell', { name: 'XYZ', exact: true }).click()
  await page.keyboard.press('End'); await page.keyboard.insertText('Q')
  await expect(page.locator('.folio-table-active .cm-content')).toHaveText('XYZQ')
  await expect.poll(async () => (await read()).content).toBe(source.replace('| A |', '| XYZQ |') + '!')
})

test('方向键在格内正常移动，仅边界切换邻格且不新增行', async ({ page }) => {
  const source = '前言\n\n| H1 | H2 |\n| --- | --- |\n| ABC | DEF |\n| GHI | JKL |\n\n尾部。'
  const { read, writes, revision } = await prepare(page, source)
  await tail(page)
  await page.getByRole('cell', { name: 'ABC', exact: true }).click()
  const input = page.locator('.folio-table-active .cm-content')
  const at = async (row: string, column: number) => expect(input).toHaveAttribute('aria-label', `表格第 ${row} 行，第 ${column} 列`)
  await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft')
  await at('1', 1)
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowLeft')
  await at('1', 1)
  await page.keyboard.press('End'); await page.keyboard.press('ArrowRight')
  await at('1', 2)
  await page.keyboard.press('ArrowLeft')
  await at('1', 1)
  await page.keyboard.press('ArrowDown')
  await at('2', 1)
  await page.keyboard.press('ArrowUp')
  await at('1', 1)
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp')
  await at('表头', 1)
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
  await at('2', 1)
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('G')
  await at('2', 1)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
  await expect(page.locator('.folio-preview-table td')).toHaveCount(4)
})

test('自动换行单元格的上下键先移动显示行，再切换同列单元格', async ({ page }) => {
  const source = '前言\n\n| H1 | H2 |\n| --- | --- |\n| long words repeated across several visual lines | B |\n| C | D |\n\n尾部。'
  const { read, writes, revision } = await prepare(page, source)
  await tail(page)
  await page.addStyleTag({ content: '.folio-preview-table table { table-layout: fixed; width: 200px; min-width: 200px; } .folio-preview-table td, .folio-preview-table th { width: 100px; max-width: 100px; }' })
  await page.getByRole('cell', { name: 'long words repeated across several visual lines', exact: true }).click()
  const input = page.locator('.folio-table-active .cm-content')
  expect(await input.evaluate(element => element.clientHeight / parseFloat(getComputedStyle(element).lineHeight))).toBeGreaterThan(2)
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown')
  await expect(input).toHaveAttribute('aria-label', '表格第 1 行，第 1 列')
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('End'); await page.keyboard.press('ArrowDown')
  await expect(input).toHaveAttribute('aria-label', '表格第 2 行，第 1 列')
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})
