import { test, expect } from '@playwright/test'
import fixtures from '../fixtures/markdown.json' with { type: 'json' }
import { readFile } from 'node:fs/promises'

test('Markdown 真实 Crepe 往返快照', async ({ page }) => {
  await page.goto('/?demo=1')
  await expect(page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })).toBeVisible()
  const results = await page.evaluate(async (corpus) => {
    // @ts-expect-error 由 Vite 提供浏览器模块。
    const { inspectRoundTrip } = await import('/src/editors/milkdown/engine.ts')
    const output = []
    for (const fixture of corpus) output.push({ ...fixture, ...await inspectRoundTrip(fixture.source) })
    return output
  }, fixtures)
  expect(JSON.stringify(results, null, 2)).toMatchSnapshot('markdown-roundtrip.json')
  expect(results.find((item) => item.name === 'Unicode')?.safe).toBe(true)
  expect(results.find((item) => item.name === 'frontmatter')?.safe).toBe(false)
  expect(results.find((item) => item.name === '引用式链接')?.safe).toBe(false)
})

test('快速切换保留最后输入，实例销毁后无旧回调写入', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/?demo=1')
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await rich.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('最后输入不能丢失')
  await page.getByRole('tab', { name: '工作区.json' }).click()
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await expect(source).toBeVisible()
  await source.click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('JSON独立草稿')
  for (let i = 0; i < 3; i++) {
    await page.getByRole('tab', { name: '开始使用.md' }).click()
    await expect(rich).toContainText('最后输入不能丢失')
    await expect(page.locator('.ProseMirror')).toHaveCount(1)
    await page.getByRole('tab', { name: '工作区.json' }).click()
    await expect(source).toContainText('JSON独立草稿')
    await expect(page.locator('.ProseMirror')).toHaveCount(0)
    await expect(page.locator('.cm-editor')).toHaveCount(1)
  }
  await page.getByRole('tab', { name: '开始使用.md' }).click()
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(source).toContainText('最后输入不能丢失')
  expect(errors).toEqual([])
})

test('有损转换保留原文，下载导出完整草稿', async ({ page }) => {
  await page.goto('/?demo=1')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await expect(source).toBeVisible()
  const original = '---\ntitle: 不能丢失\n---\n\n正文\n'
  await source.fill(original)
  await page.getByRole('button', { name: '富文本', exact: true }).click()
  await expect(page.getByText('此文档经富文本转换后会发生变化。已保留完整原文，请使用源码编辑。')).toBeVisible()
  await expect(source).toContainText('title: 不能丢失')
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载当前草稿', exact: true }).click()
  const download = await pending
  expect(await readFile((await download.path())!, 'utf8')).toBe(original)
  await expect(page.locator('.save-status')).toContainText('未保存')
})

test('异步创建期间反复切换只留下一个活动编辑器', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/?demo=1')
  for (let i = 0; i < 5; i++) {
    await page.getByRole('tab', { name: '工作区.json' }).click()
    await page.getByRole('tab', { name: '开始使用.md' }).click()
  }
  await expect(page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })).toBeVisible()
  await expect(page.locator('.ProseMirror')).toHaveCount(1)
  expect(errors).toEqual([])
})

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`主题与布局 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.goto('/?demo=1')
    if (viewport.width < 768 && await page.getByRole('button', { name: '收起文件列表' }).isVisible()) await page.getByRole('button', { name: '收起文件列表' }).click()
    await expect(page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })).toBeVisible()
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
