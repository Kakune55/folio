import { test, expect } from '@playwright/test'
import fixtures from '../fixtures/markdown.json' with { type: 'json' }
import { readFile } from 'node:fs/promises'

test('Markdown 语料创建 CM state 后原始字节不变', async ({ page }) => {
  await page.goto('/?demo=1')
  await expect(page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true })).toBeVisible()
  const results = await page.evaluate(async (corpus) => {
    // 从 Vite 转换结果取得同一依赖 URL（含版本参数），避免创建第二份 CM state。
    const module = await (await fetch('/src/editors/codemirror/line-endings.ts')).text()
    const stateURL = /from\s+["']([^"']*@codemirror_state[^"']*)["']/.exec(module)?.[1]
    if (!stateURL) throw new Error('未找到 CM state 浏览器依赖入口')
    const { EditorState } = await import(stateURL)
    // @ts-expect-error Vite 提供浏览器模块。
    const { preserveLineEndings } = await import('/src/editors/codemirror/line-endings.ts')
    return corpus.map(fixture => {
      const mapping = preserveLineEndings(fixture.source)
      const state = EditorState.create({ doc: mapping.doc, extensions: mapping.extension })
      return { name: fixture.name, source: mapping.serialize(state) }
    })
  }, fixtures)
  expect(results).toEqual(fixtures.map(({ name, source }) => ({ name, source })))
})

test('源码与实时预览共用 DOM、选区及撤销历史', async ({ page }) => {
  await page.goto('/?demo=1')
  const editor = page.locator('.cm-content')
  await editor.fill('原文 ABC')
  await page.waitForTimeout(600) // 跨过 CM history 默认分组窗口，单独验证后续输入的撤销。
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('新增')
  await page.keyboard.press('Shift+ArrowLeft')
  const node = await editor.elementHandle()
  for (const mode of ['源码', '实时预览', '源码', '实时预览']) {
    await page.getByRole('button', { name: mode, exact: true }).click()
    expect(await editor.evaluate((element, original) => element === original, node)).toBe(true)
    await expect(page.locator('.cm-editor')).toHaveCount(1)
    await expect(page.locator('.source-host')).toHaveAttribute('data-mode', mode === '源码' ? 'source' : 'rich')
    await editor.focus()
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('增')
  }
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor).toHaveText('原文 ABC')
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect(editor).toHaveText('原文 ABC新增')
})

for (const original of [
  '---\ntitle: 不能丢失\n---\n\n[unused]: /keep "定义"\n\n正文\n',
  '\uFEFF# BOM\r\n\r\n```js filename="keep.js"\rconst a = 1\n```\r\n无末尾换行',
]) test(`疑难语法直接编辑与下载保留原文 ${original.includes('\uFEFF') ? 'BOM 混合换行' : '定义和元数据'}`, async ({ page }) => {
  await page.goto('/?demo=1')
  const editor = page.locator('.cm-content')
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+a')
  // 合成剪贴板事件只验证应用的纯文本粘贴路径，不代表真实系统剪贴板。
  await editor.evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, original)
  for (const mode of ['源码', '实时预览']) await page.getByRole('button', { name: mode, exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载当前草稿', exact: true }).click()
  expect(await readFile((await (await pending).path())!, 'utf8')).toBe(original)
  await expect(page.locator('.save-status')).toContainText('未保存')
})

test('快速切换文件保留最后输入且仅有一个 CM', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/?demo=1')
  const editor = page.locator('.cm-content')
  await editor.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('最后输入不能丢失')
  await page.getByRole('tab', { name: '工作区.json' }).click()
  await editor.focus(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.insertText('JSON独立草稿')
  for (let i = 0; i < 3; i++) {
    await page.getByRole('tab', { name: '开始使用.md' }).click()
    await expect(editor).toContainText('最后输入不能丢失')
    await expect(page.locator('.cm-editor')).toHaveCount(1)
    await page.getByRole('tab', { name: '工作区.json' }).click()
    await expect(editor).toContainText('JSON独立草稿')
    await expect(page.locator('.cm-editor')).toHaveCount(1)
  }
  expect(errors).toEqual([])
})

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`主题与布局 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.goto('/?demo=1')
    if (viewport.width < 768 && await page.getByRole('button', { name: '收起文件列表' }).isVisible()) await page.getByRole('button', { name: '收起文件列表' }).click()
    await expect(page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/workbench-${viewport.width}-light.png` })
    await page.getByRole('button', { name: '主题：跟随系统', exact: true }).click()
    await page.getByRole('button', { name: '主题：浅色', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.screenshot({ path: `test-results/workbench-${viewport.width}-dark.png` })
    await page.getByRole('button', { name: '关于当前版本' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '关于当前版本' })).toBeFocused()
  })
}
