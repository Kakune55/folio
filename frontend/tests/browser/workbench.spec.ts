import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
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
  expect(results.find((item) => item.name === '嵌套任务列表')?.safe).toBe(true)
  expect(results.find((item) => item.name === '表格')?.safe).toBe(true)
  expect(results.find((item) => item.name === '空白与换行')?.safe).toBe(true)
  expect(results.find((item) => item.name === 'frontmatter')?.safe).toBe(false)
  expect(results.find((item) => item.name === '引用式链接')?.safe).toBe(false)
  expect(results.find((item) => item.name === '脚注未承诺支持')?.safe).toBe(false)
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
  const dialog = page.getByRole('dialog', { name: '富文本转换预览' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('转换前原文')).toHaveValue(original)
  await expect(dialog.getByRole('button', { name: '保留原文，使用源码' })).toBeFocused()
  await dialog.getByText('查看 Diff（- 原文 / + 转换后）', { exact: true }).click()
  await expect(dialog.getByLabel('转换差异')).toContainText('- --- [LF]')
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(dialog.locator('.diff-line.diff-delete').first()).toBeVisible()
      const colors = await dialog.evaluate(el => {
        const removed = el.querySelector('.diff-delete')!, added = el.querySelector('.diff-insert')!
        return [getComputedStyle(removed).backgroundColor, getComputedStyle(added).backgroundColor]
      })
      expect(colors[0]).not.toBe(colors[1])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([])
      await page.screenshot({ path: `test-results/diff-${theme}-${width}.png` })
    }
  }
  const originalDownload = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '下载转换前原文' }).click()
  expect(await readFile((await (await originalDownload).path())!, 'utf8')).toBe(original)
  await page.keyboard.press('Escape')
  await expect(page.getByText('此文档经富文本转换后会发生变化。已保留完整原文，请使用源码编辑。')).toBeVisible()
  await expect(source).toContainText('title: 不能丢失')
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载当前草稿', exact: true }).click()
  const download = await pending
  expect(await readFile((await download.path())!, 'utf8')).toBe(original)
  await expect(page.locator('.save-status')).toContainText('未保存')
})

test('确认有损转换后采用预览结果，切换文件及模式保留转换正文', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/?demo=1')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await source.fill('---\ntitle: 转换确认\n---\n\n正文\n')
  await page.getByRole('button', { name: '富文本', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '富文本转换预览' })
  const converted = await dialog.getByLabel('转换后 Markdown').inputValue()
  expect(converted).not.toBe(await dialog.getByLabel('转换前原文').inputValue())
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await dialog.getByRole('button', { name: '确认转换并编辑' }).click()
  await expect(dialog).not.toBeVisible()
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await expect(rich).toBeVisible()
  await page.getByRole('tab', { name: '工作区.json' }).click()
  await page.getByRole('tab', { name: '开始使用.md' }).click()
  await expect(rich).toBeVisible()
  await expect(dialog).not.toBeVisible()
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(source).toContainText('正文')
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载当前草稿', exact: true }).click()
  expect(await readFile((await (await pending).path())!, 'utf8')).toBe(converted)
})

test('预览期间草稿变化后拒绝应用旧转换', async ({ page }) => {
  await page.goto('/?demo=1')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await page.getByRole('textbox', { name: '源码编辑器' }).fill('---\ntitle: 旧文\n---\n')
  await page.getByRole('button', { name: '富文本', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '富文本转换预览' })
  await expect(dialog).toBeVisible()
  await page.evaluate(async () => {
    // @ts-expect-error 由 Vite 提供浏览器模块。
    const { workspace } = await import('/src/sessions/demo.ts')
    workspace.update('开始使用.md', '更新后的原文\r\n')
  })
  await dialog.getByRole('button', { name: '确认转换并编辑' }).click()
  await expect(page.getByRole('textbox', { name: '源码编辑器' })).toContainText('更新后的原文')
  await expect(page.getByText('预览期间原文或文件状态已变化，请重新检查转换。当前原文已保留。')).toBeVisible()
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
