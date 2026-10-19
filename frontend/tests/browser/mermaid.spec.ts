import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
async function openDiagram(page: Page, body: string) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  const path = `图表-${Date.now()}.md`, headers = { 'X-CSRF-Token': me.csrfToken }
  expect((await page.request.post('/api/v1/files', { headers, data: { path, content: body } })).status()).toBe(201)
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name: path, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })).toBeVisible()
  return { path, read: async () => (await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)).json()).content }
}

test('Mermaid 流程图/时序图预览、主题、编辑与源码保留', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  const original = '# Mermaid\n\n```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob: 你好\n```\n'
  const { read } = await openDiagram(page, original)
  const previews = page.locator('.mermaid-preview')
  await expect(previews.locator('img')).toHaveCount(2)
  await expect.poll(() => previews.locator('img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  expect(await previews.locator('img').first().evaluate(img => img.getBoundingClientRect().width)).toBeLessThan(600)
  const svg = decodeURIComponent((await previews.locator('img').first().getAttribute('src'))!.split(',').slice(1).join(','))
  expect(svg).toContain('开始'); expect(svg).toContain('结束')
  expect(await read()).toBe(original)
  await page.locator('.ProseMirror').evaluate(el => el.setAttribute('data-instance-test', '保留实例'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
    await expect(previews.locator('img').first()).toHaveAttribute('data-theme', theme === 'dark' ? 'dark' : 'default')
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 })
      if (width === 390 && await page.getByRole('button', { name: '关闭文件列表' }).isVisible()) await page.getByRole('button', { name: '关闭文件列表' }).click()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
      await page.screenshot({ path: `../artifacts/mermaid/mermaid-${theme}-${width}.png` })
    }
  }
  await expect(page.locator('.ProseMirror')).toHaveAttribute('data-instance-test', '保留实例')
  expect(await read()).toBe(original)
  await page.setViewportSize({ width: 1440, height: 900 })
  const code = page.locator('.milkdown-code-block .cm-content').first()
  await code.fill('flowchart LR\nA[修改后] --> B[确认]')
  await expect.poll(async () => decodeURIComponent((await previews.locator('img').first().getAttribute('src')) ?? '')).toContain('修改后')
  await expect.poll(read).toContain('A[修改后]')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '源码编辑器' })).toContainText('A[修改后]')
  await page.getByRole('button', { name: '富文本', exact: true }).click()
  await expect(page.locator('.mermaid-preview img')).toHaveCount(2)
  expect(errors).toEqual([])
})

test('错误 Mermaid 明确提示并可修复，活动资源不加载', async ({ page }) => {
  const external: string[] = []; page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:')) external.push(request.url()) })
  const original = '```mermaid\nflowchart LR\n A[语法未闭合\n```\n'
  const { read } = await openDiagram(page, original)
  const preview = page.locator('.mermaid-preview')
  await expect(preview).toContainText('Mermaid 渲染失败')
  expect(await read()).toBe(original)
  const code = page.locator('.milkdown-code-block .cm-content')
  for (const malicious of ['flowchart LR\nA@{img: "https://evil.test/a.png"}', '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B', 'flowchart LR\nA["<img src=x onerror=alert(1)>"]']) {
    await code.fill(malicious)
    await expect(preview).toContainText('暂不支持 Mermaid')
    await expect(preview.locator('img')).toHaveCount(0)
  }
  await code.fill('flowchart LR\nA[修复]-->B[完成]')
  await expect(preview.locator('img')).toBeVisible()
  expect(external).toEqual([])
  // 新旧异步任务交错与卸载不能恢复过期图表或改写正文。
  await code.fill('flowchart LR\nA[过期]-->B')
  await code.fill('flowchart LR\nA[最新]-->B')
  await expect.poll(async () => decodeURIComponent((await preview.locator('img').getAttribute('src')) ?? '')).toContain('最新')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '源码编辑器' })).toContainText('最新')
})


test('代码块语言菜单可以选择 Mermaid', async ({ page }) => {
  await openDiagram(page, '```text\nflowchart LR\nA[菜单插入]-->B\n```\n')
  await page.locator('.milkdown-code-block .language-button').click()
  await page.getByPlaceholder('搜索语言').fill('mermaid')
  await page.locator('.language-list-item[data-language="mermaid"]').click()
  await expect(page.locator('.mermaid-preview img')).toBeVisible()
})


test('连续输入防抖只渲染最终代码，等待期间保留原图且各块互不阻塞', async ({ page }) => {
  const { read } = await openDiagram(page, '```mermaid\nflowchart LR\nA[原图]-->B\n```\n\n```mermaid\nflowchart LR\nC[第二张]-->D\n```\n')
  const previews = page.locator('.mermaid-preview')
  await expect(previews.locator('img')).toHaveCount(2)
  const first = previews.nth(0), second = previews.nth(1)
  const original = await first.locator('img').getAttribute('src')
  const originalHeight = await first.evaluate(el => el.getBoundingClientRect().height)
  await page.evaluate(() => {
    const state = { renders: 0, blankFrames: 0, stop: false }
    Object.assign(window, { mermaidDebounceProbe: state })
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && node.id.startsWith('dfolio-mermaid-')) state.renders++
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const frame = () => {
      if (state.stop) { observer.disconnect(); return }
      if (document.querySelectorAll('.mermaid-preview img').length !== 2) state.blankFrames++
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  const code = page.locator('.milkdown-code-block .cm-content')
  for (const text of ['第一笔', '第二笔', '第三笔', '最终结果']) {
    await code.nth(0).fill(`flowchart LR\nA[${text}]-->B`)
    await page.waitForTimeout(180) // 每笔间隔小于 600ms，整个输入序列超过 600ms。
    await expect(first.locator('img')).toHaveAttribute('src', original!)
    expect(Math.abs(await first.evaluate(el => el.getBoundingClientRect().height) - originalHeight)).toBeLessThan(1)
  }
  expect(await page.evaluate(() => (window as unknown as { mermaidDebounceProbe: { renders: number } }).mermaidDebounceProbe.renders)).toBe(0)
  // 编辑另一代码块不会重置第一块的等待时间。
  await code.nth(1).fill('flowchart LR\nC[独立更新]-->D')
  await expect.poll(async () => decodeURIComponent(await first.locator('img').getAttribute('src') ?? '')).toContain('最终结果')
  await expect.poll(async () => decodeURIComponent(await second.locator('img').getAttribute('src') ?? '')).toContain('独立更新')
  const result = await page.evaluate(() => {
    const state = (window as unknown as { mermaidDebounceProbe: { renders: number; blankFrames: number; stop: boolean } }).mermaidDebounceProbe
    state.stop = true; return state
  })
  expect(result.renders).toBe(2)
  expect(result.blankFrames).toBe(0)
  const toggle = page.locator('.milkdown-code-block').first().locator('.preview-toggle-button')
  await toggle.click()
  await expect(first.locator('img')).toBeVisible()
  await toggle.click()
  await expect(first.locator('img')).toBeVisible()
  await expect.poll(read).toContain('最终结果')
  await code.nth(0).fill('flowchart LR\nA[未闭合')
  await expect(first).toContainText('Mermaid 渲染失败')
  await expect(first.locator('img')).toHaveAttribute('alt', /上次成功/)
  await expect.poll(async () => decodeURIComponent(await first.locator('img').getAttribute('src') ?? '')).toContain('最终结果')
})
