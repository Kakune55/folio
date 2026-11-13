import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function prepare(page: Page, source = '\ufeff# 手机阅读\r\n\r\n保留空白  \n中间\r尾行') {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  const ready = page.waitForResponse(response => response.url().includes('/workspace/events?') && response.status() === 200)
  await page.getByRole('button', { name: '进入工作区' }).click()
  await ready
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const headers = { 'X-CSRF-Token': me.csrfToken }
  const directory = `手机完整路径-${Date.now()}-${test.info().testId.slice(-6)}`
  expect((await page.request.post('/api/v1/directories', { headers, data: { path: directory } })).status()).toBe(201)
  const path = `${directory}/这是一份需要保留完整路径的阅读笔记.md`
  const created = await page.request.post('/api/v1/files', { headers, data: { path, content: source } })
  expect(created.status()).toBe(201)
  const revision = (await created.json()).revision as string
  const writes: string[] = [], logouts: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === '/api/v1/files/content' && request.method() === 'PUT') writes.push(request.postDataJSON().content)
    if (url.pathname === '/api/v1/auth/logout' && request.method() === 'POST') logouts.push(request.url())
  })
  const open = async () => {
    await page.keyboard.press('Control+p')
    const search = page.getByRole('dialog', { name: '搜索', exact: true })
    await search.getByRole('combobox').fill(path)
    await search.getByRole('option').filter({ hasText: path }).click()
  }
  await open()
  const editor = page.locator('.source-host > .cm-editor')
  const content = editor.locator(':scope > .cm-scroller > .cm-content')
  await expect(content).toBeVisible()
  const read = async () => {
    const response = await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)
    expect(response.status()).toBe(200)
    const file = await response.json()
    expect(response.headers().etag).toBe(`"${file.revision}"`)
    return { content: file.content as string, revision: file.revision as string }
  }
  return { path, source, revision, editor, content, writes, logouts, read, open }
}

test('手机阅读优先两行顶栏，320/390/768/1280 明暗布局无溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { source, revision, read, writes, content } = await prepare(page)
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(page.locator('.statusbar')).toBeVisible()
      if (width < 768) {
        await expect(page.locator('.topbar-actions').getByRole('button')).toHaveCount(2)
        await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: '更多操作', exact: true })).toBeVisible()
        await expect(page.locator('.document-toolbar, .breadcrumb, .editor-formatbar')).toHaveCount(0)
        await expect(page.getByRole('button', { name: '格式工具', exact: true })).toHaveAttribute('aria-expanded', 'false')
        for (const button of await page.locator('.topbar-actions button, .mobile-editor-actions button, #explorer-toggle').all()) {
          const box = await button.boundingBox()
          expect(box!.x).toBeGreaterThanOrEqual(0)
          expect(box!.x + box!.width).toBeLessThanOrEqual(width)
        }
        const topbar = await page.locator('.topbar').boundingBox(), tabs = await page.locator('.tabs-row').boundingBox()
        expect(Math.abs(topbar!.height + tabs!.height - 92)).toBeLessThanOrEqual(4)
        expect(tabs!.y).toBe(topbar!.y + topbar!.height)
        await expect(page.locator('.notice')).toHaveCount(0)
        const bounds = await content.boundingBox()
        expect(bounds!.y).toBeGreaterThanOrEqual(88)
        expect(bounds!.y).toBeLessThanOrEqual(130)
        await page.screenshot({ path: test.info().outputPath(`reading-workbench-${width}-${theme}.png`) })
      } else {
        await expect(page.locator('.document-toolbar')).toBeVisible()
        await expect(page.locator('.editor-formatbar')).toBeVisible()
        for (const name of ['打开回收站', '上传附件', '个性化', '查看快捷键', '退出登录', '保存当前文件', '下载当前草稿']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: '更多操作', exact: true })).toHaveCount(0)
      }
    }
  }
  await page.waitForTimeout(1100)
  expect(await read()).toEqual({ content: source, revision })
  expect(writes).toEqual([])
})

test('手机更多菜单完整路径可读可滚动，键盘及 Dialog 焦点不破坏正文', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 430 })
  const { path, source, revision, read, writes, editor } = await prepare(page)
  await editor.evaluate(element => element.setAttribute('data-instance', 'menu-original'))
  const more = page.getByRole('button', { name: '更多操作', exact: true })
  await more.focus(); await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const label = menu.locator('.workbench-menu-label')
  await expect(label).toHaveText(path)
  expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  for (const name of ['打开回收站', '上传附件', '个性化', '快捷键', '分享管理', '创建分享', '保存当前文件', '下载当前草稿']) await expect(menu.getByRole('menuitem', { name, exact: true })).toBeAttached()
  expect(await menu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
    expect.soft((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([])
  }
  await page.keyboard.press('End')
  await expect(menu.getByRole('menuitem', { name: '退出登录', exact: true })).toBeFocused()
  await expect(menu.getByRole('menuitem', { name: '退出登录', exact: true })).toBeInViewport()
  await page.keyboard.press('Escape'); await expect(more).toBeFocused()
  for (const [item, title] of [['个性化', '个性化'], ['快捷键', '工作区快捷键']] as const) {
    await more.click(); await page.getByRole('menuitem', { name: item, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: title, exact: true })
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(more).toBeFocused()
    await expect(editor).toHaveAttribute('data-instance', 'menu-original')
  }
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
})

test('手机 Aa 与源码实时预览切换保留同一 CM6、选区、undo 和 BOM 混合换行', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { source, content, editor, writes, read, revision, open } = await prepare(page)
  await editor.evaluate(element => element.setAttribute('data-instance', 'original'))
  const node = await editor.elementHandle()
  const aa = page.getByRole('button', { name: '格式工具', exact: true })
  await content.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('Shift+ArrowLeft')
  const selection = await page.evaluate(() => window.getSelection()?.toString())
  expect(selection).toBe('行')
  for (const action of ['展开', '源码', '收起', '实时预览']) {
    if (action === '展开' || action === '收起') {
      await aa.click()
      await expect(aa).toHaveAttribute('aria-expanded', String(action === '展开'))
      await expect(page.locator('.editor-formatbar')).toHaveCount(action === '展开' ? 1 : 0)
    } else await page.getByRole('button', { name: action, exact: true }).click()
    await expect(editor).toHaveAttribute('data-instance', 'original')
    expect(await editor.evaluate((element, previous) => element === previous, node)).toBe(true)
    await content.focus()
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection)
  }
  await open()
  await page.waitForTimeout(1100)
  expect(await read()).toEqual({ content: source, revision }); expect(writes).toEqual([])
  await content.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('新增')
  await expect.poll(async () => (await read()).content).toBe(source + '新增')
  await aa.click(); await page.getByRole('button', { name: '源码', exact: true }).click(); await aa.click()
  await content.focus(); await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await read()).content).toBe(source)
  await expect(editor).toHaveAttribute('data-instance', 'original')
  expect(writes).toEqual([source + '新增', source])
})

test('手机候选仿真阻止保存格式操作，退出 flush 失败保留 session 和恢复稿', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { path, content, source, editor, writes, logouts, read, revision } = await prepare(page)
  await page.route('**/api/v1/files/content?**', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { error: { code: 'test_save_failed', message: '测试保存失败，保留草稿' } } }) : route.continue())
  await page.getByRole('button', { name: '格式工具', exact: true }).click()
  await content.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('未保存草稿')
  await expect(page.locator('.save-status')).toContainText('保存失败')
  await content.dispatchEvent('compositionstart', { data: '' })
  await expect(page.getByRole('button', { name: '格式工具', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '源码', exact: true })).toBeDisabled()
  await expect(page.locator('.editor-formatbar').getByRole('button', { name: '加粗', exact: true })).toBeDisabled()
  const more = page.getByRole('button', { name: '更多操作', exact: true })
  await more.click()
  await expect(page.getByRole('menuitem', { name: '保存当前文件', exact: true })).toHaveAttribute('data-disabled', '')
  await page.keyboard.press('Escape')
  const before = writes.length
  await content.dispatchEvent('keydown', { key: 's', ctrlKey: true, isComposing: true })
  await page.waitForTimeout(1100)
  expect(writes).toHaveLength(before)
  await content.dispatchEvent('compositionend', { data: '' })
  await page.getByRole('button', { name: '重试保存', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('测试保存失败，保留草稿')
  const attempts = writes.length
  await more.click(); await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(page.locator('.notice').filter({ hasText: '有文件未能保存，已保留登录状态' })).toBeVisible()
  expect(writes.length).toBeGreaterThan(attempts)
  await expect(content).toContainText('未保存草稿')
  await expect(editor).toBeVisible()
  expect(logouts).toEqual([])
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(200)
  expect(await read()).toEqual({ content: source, revision })
  await expect.poll(() => page.evaluate(async path => new Promise<string | undefined>(resolve => {
    const request = indexedDB.open('folio-recovery', 1)
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('drafts', 'readonly'), query = transaction.objectStore('drafts').getAll()
      transaction.oncomplete = () => { db.close(); resolve(query.result.find((draft: { path: string }) => draft.path === path)?.source) }
    }
  }), path)).toBe(source + '未保存草稿')
})
