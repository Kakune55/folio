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
  const created = await page.request.post('/api/v1/files', { headers, data: { path, content: body } })
  expect(created.status()).toBe(201)
  const revision: string = (await created.json()).revision
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name: path, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true })).toBeVisible()
  return { path, revision, read: async () => (await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)).json()).content,
    readRevision: async () => (await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)).json()).revision as string }
}

async function editDiagram(page: Page, index: number, body: string) {
  const opening = page.locator('.folio-code-opening').filter({ has: page.locator('.folio-code-tools[data-language="mermaid"]') }).nth(index)
  await opening.click({ position: { x: 8, y: 10 } })
  await expect(opening).toContainText('```mermaid')
  const lines = page.locator('.cm-content .cm-line')
  const text = await lines.evaluateAll(elements => elements.map(element => {
    const copy = element.cloneNode(true) as HTMLElement
    copy.querySelectorAll('.folio-code-tools').forEach(tool => tool.remove())
    return copy.textContent
  }))
  const start = text.findIndex(line => line === '```mermaid')
  const end = text.findIndex((line, position) => position > start && line === '```')
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start + 1)
  await lines.nth(start + 1).click(); await page.keyboard.press('Home')
  await page.keyboard.down('Shift')
  for (let i = start + 2; i < end; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End'); await page.keyboard.up('Shift')
  await page.keyboard.insertText(body)
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
  await page.locator('.cm-content').evaluate(el => el.setAttribute('data-instance-test', '保留实例'))
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
  await expect(page.locator('.cm-content')).toHaveAttribute('data-instance-test', '保留实例')
  expect(await read()).toBe(original)
  await page.setViewportSize({ width: 1440, height: 900 })
  await editDiagram(page, 0, 'flowchart LR\nA[修改后] --> B[确认]')
  await expect.poll(async () => decodeURIComponent((await previews.locator('img').first().getAttribute('src')) ?? '')).toContain('修改后')
  await expect.poll(read).toContain('A[修改后]')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '源码编辑器' })).toContainText('A[修改后]')
  await expect(previews).toHaveCount(0)
  await expect(page.locator('.cm-content')).toHaveAttribute('data-instance-test', '保留实例')
  await page.getByRole('button', { name: '实时预览', exact: true }).click()
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
  for (const malicious of ['flowchart LR\nA@{img: "https://evil.test/a.png"}', '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B', 'flowchart LR\nA["<img src=x onerror=alert(1)>"]']) {
    await editDiagram(page, 0, malicious)
    await expect(preview).toContainText('暂不支持 Mermaid')
    await expect(preview.locator('img')).toHaveCount(0)
  }
  await editDiagram(page, 0, 'flowchart LR\nA[修复]-->B[完成]')
  await expect(preview.locator('img')).toBeVisible()
  expect(external).toEqual([])
  // 新旧异步任务交错与卸载不能恢复过期图表或改写正文。
  await editDiagram(page, 0, 'flowchart LR\nA[过期]-->B')
  await editDiagram(page, 0, 'flowchart LR\nA[最新]-->B')
  await expect.poll(async () => decodeURIComponent((await preview.locator('img').getAttribute('src')) ?? '')).toContain('最新')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '源码编辑器' })).toContainText('最新')
})


test('直接编辑围栏语言创建 Mermaid 预览，原文只改变语言标记', async ({ page }) => {
  const original = '```text\nflowchart LR\nA[围栏插入]-->B\n```\n'
  const { read } = await openDiagram(page, original)
  await expect(page.locator('.mermaid-preview')).toHaveCount(0)
  await page.locator('.cm-line').first().click(); await page.keyboard.press('Home')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+End'); await page.keyboard.insertText('mermaid')
  await expect(page.locator('.mermaid-preview img')).toBeVisible()
  await expect.poll(read).toBe(original.replace('```text', '```mermaid'))
  await expect(page.locator('.cm-editor')).toHaveCount(1)
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
  for (const text of ['第一笔', '第二笔', '第三笔', '最终结果']) {
    await editDiagram(page, 0, `flowchart LR\nA[${text}]-->B`)
    await page.waitForTimeout(180) // 每笔间隔小于 600ms，整个输入序列超过 600ms。
    await expect(first.locator('img')).toHaveAttribute('src', original!)
    expect(Math.abs(await first.evaluate(el => el.getBoundingClientRect().height) - originalHeight)).toBeLessThan(1)
  }
  expect(await page.evaluate(() => (window as unknown as { mermaidDebounceProbe: { renders: number } }).mermaidDebounceProbe.renders)).toBe(0)
  // 编辑另一代码块不会重置第一块的等待时间。
  await editDiagram(page, 1, 'flowchart LR\nC[独立更新]-->D')
  await expect.poll(async () => decodeURIComponent(await first.locator('img').getAttribute('src') ?? '')).toContain('最终结果')
  await expect.poll(async () => decodeURIComponent(await second.locator('img').getAttribute('src') ?? '')).toContain('独立更新')
  const result = await page.evaluate(() => {
    const state = (window as unknown as { mermaidDebounceProbe: { renders: number; blankFrames: number; stop: boolean } }).mermaidDebounceProbe
    state.stop = true; return state
  })
  expect(result.renders).toBe(2)
  expect(result.blankFrames).toBe(0)
  await expect.poll(read).toContain('最终结果')
  await editDiagram(page, 0, 'flowchart LR\nA[未闭合')
  await expect(first).toContainText('Mermaid 渲染失败')
  await expect(first.locator('img')).toHaveAttribute('alt', /上次成功/)
  await expect.poll(async () => decodeURIComponent(await first.locator('img').getAttribute('src') ?? '')).toContain('最终结果')
})

test('长文滚动销毁图表控件后返回命中缓存，不重复渲染或闪加载状态', async ({ page }) => {
  const original = '```mermaid\nflowchart LR\nA[缓存图表]-->B[返回]\n```\n\n' + '正文段落。\n\n'.repeat(1000)
  const { read, readRevision, revision } = await openDiagram(page, original)
  const preview = page.locator('.mermaid-preview')
  await expect(preview).toHaveAttribute('data-state', 'ready')
  const initial = await preview.locator('img').getAttribute('src')
  const savedStatus = await page.locator('.save-status').textContent()
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/files/content') writes.push(request.postDataJSON().content) })
  await page.evaluate(() => {
    const result = { renders: 0, pending: 0 }
    Object.assign(window, { mermaidCacheProbe: result })
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.id.startsWith('dfolio-mermaid-')) result.renders++
        for (const host of [node, ...node.querySelectorAll('.mermaid-preview')]) {
          if (host.matches('.mermaid-preview') && host.getAttribute('data-state') !== 'ready') result.pending++
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  for (let iteration = 0; iteration < 2; iteration++) {
    const previous = await preview.elementHandle()
    await page.locator('.source-host > .cm-editor > .cm-scroller').evaluate(element => element.scrollTop = element.scrollHeight)
    await expect.poll(() => previous!.evaluate(element => element.isConnected)).toBe(false)
    await page.locator('.source-host > .cm-editor > .cm-scroller').evaluate(element => element.scrollTop = 0)
    await expect(preview).toHaveAttribute('data-state', 'ready')
    await expect(preview.locator('img')).toHaveAttribute('src', initial!)
  }
  await page.waitForTimeout(800) // 超过 600ms 渲染防抖窗口，确保没有偷偷排队重画。
  expect(await page.evaluate(() => (window as unknown as { mermaidCacheProbe: { renders: number; pending: number } }).mermaidCacheProbe)).toEqual({ renders: 0, pending: 0 })
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  await expect(preview.locator('img')).toHaveAttribute('data-theme', 'dark')
  const afterDark = await page.evaluate(() => (window as unknown as { mermaidCacheProbe: { renders: number } }).mermaidCacheProbe.renders)
  expect(afterDark).toBe(1)
  await page.evaluate(() => document.documentElement.dataset.theme = 'light')
  await expect(preview.locator('img')).toHaveAttribute('src', initial!)
  expect(await page.evaluate(() => (window as unknown as { mermaidCacheProbe: { renders: number } }).mermaidCacheProbe.renders)).toBe(afterDark)
  expect(await read()).toBe(original); expect(writes).toEqual([])
  expect(await readRevision()).toBe(revision)
  await expect(page.locator('.save-status')).toHaveText(savedStatus!)
})
