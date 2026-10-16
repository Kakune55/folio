import { test, expect } from '@playwright/test'
import type { Locator } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { availableParallelism, cpus, platform, arch } from 'node:os'
import { createHash } from 'node:crypto'
import { fixtureRoot, login, report } from './helpers'

const budgets = { firstPage: 1000, nextPage: 1500, searchAPI: 100, editorOpen: 3000, input: 300, quickOpen: 1000 }

test('1200 文件分页、中文全文搜索及较大正文实际交互测量', async ({ page }) => {
  const directory = await mkdtemp(join(await fixtureRoot(), 'QA-性能-'))
  const folder = basename(directory)
  const richSource = '# 较大 Markdown\n\n' + Array.from({ length: 600 }, (_, index) => `第 ${index} 段：真实文件是正文权威。${'中文阅读与编辑保持独立缓冲区。'.repeat(5)}`).join('\n\n') + '\n'
  const textSource = ('request_id=trace-123456 level=info message=' + 'x'.repeat(160) + '\n').repeat(5200)
  const unique = '中文性能终点' + folder
  const count = 1200
  try {
    for (let offset = 0; offset < count; offset += 40) await Promise.all(Array.from({ length: Math.min(40, count - offset) }, (_, delta) => {
      const index = offset + delta
      return writeFile(join(directory, `note-${String(index).padStart(4, '0')}.md`), `# 性能样本 ${index}\n\nrequest_id 中文全文检索。${index === count - 1 ? unique : ''}\n`)
    }))
    await Promise.all([writeFile(join(directory, 'large.md'), richSource), writeFile(join(directory, 'large.log'), textSource)])
    await page.setViewportSize({ width: 1440, height: 900 })
    await login(page)
    const principal = await (await page.request.get('/api/v1/auth/me')).json()
    expect((await page.request.post('/api/v1/search/rebuild', { headers: { 'X-CSRF-Token': principal.csrfToken } })).status()).toBe(202)
    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/search?q=${encodeURIComponent(unique)}`)
      const value = await response.json()
      return value.entries?.some((entry: { path: string }) => entry.path === `${folder}/note-1199.md`) && !value.status?.indexing
    }, { timeout: 30_000 }).toBe(true)
    const treeStart = performance.now()
    await page.getByRole('button', { name: folder, exact: true }).click()
    const nav = page.getByRole('navigation', { name: '工作区文件' })
    const rows = nav.locator(`[data-entry-path^="${folder}/"]`)
    await expect(rows).toHaveCount(200)
    const firstPageMs = performance.now() - treeStart
    const pagesMs: number[] = []
    for (let target = 400; target <= 1400; target += 200) {
      const start = performance.now()
      await nav.getByRole('button', { name: '加载更多', exact: true }).click()
      await expect(rows).toHaveCount(Math.min(count + 2, target))
      pagesMs.push(performance.now() - start)
    }
    expect(await rows.count()).toBe(count + 2)
    const namesMs: number[] = [], fullMs: number[] = []
    for (let i = 0; i < 3; i++) {
      for (const mode of ['names', 'full']) {
        const start = performance.now()
        const query = mode === 'names' ? `${folder}/note-1199` : 'request_id'
        const response = await page.request.get(`/api/v1/search?mode=${mode === 'names' ? 'names' : ''}&q=${encodeURIComponent(query)}`)
        expect(response.status()).toBe(200)
        const result = await response.json()
        if (mode === 'names') expect(result.entries.map((entry: { path: string }) => entry.path)).toEqual([`${folder}/note-1199.md`])
        else { expect(result.entries.length).toBe(50); expect(result.truncated).toBe(true) }
        ;(mode === 'names' ? namesMs : fullMs).push(performance.now() - start)
      }
    }
    const openStart = performance.now()
    await page.getByRole('button', { name: 'large.md', exact: true }).click()
    const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
    await expect(rich).toBeVisible({ timeout: 20_000 })
    const richOpenMs = performance.now() - openStart
    const input = async (editor: Locator, markers: string[]) => {
      await editor.focus(); await page.keyboard.press('Control+End')
      const samples = []
      for (const marker of markers) {
        const start = performance.now()
        await page.keyboard.insertText(marker)
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        samples.push(performance.now() - start)
      }
      return samples
    }
    const richInputMs = await input(rich, ['甲', '乙', '丙'])
    await expect(page.locator('.save-status')).toHaveText('已保存', { timeout: 15_000 })
    const richSaved = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(folder + '/large.md')}`)).json()
    expect(richSaved.content).toBe(richSource.slice(0, -1) + '甲乙丙\n')
    const sourceStart = performance.now()
    await page.getByRole('button', { name: 'large.log', exact: true }).click()
    const source = page.getByRole('textbox', { name: '源码编辑器' })
    await expect(source).toBeVisible()
    const sourceOpenMs = performance.now() - sourceStart
    const sourceInputMs = await input(source, ['丁', '戊', '己'])
    await expect(page.locator('.save-status')).toHaveText('已保存', { timeout: 15_000 })
    const textSaved = await (await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(folder + '/large.log')}`)).json()
    expect(textSaved.content).toBe(textSource + '丁戊己')
    await page.getByRole('button', { name: '快速打开文件' }).click()
    const searchStart = performance.now()
    await page.getByRole('combobox').fill(`${folder}/note-1199`)
    await expect(page.getByRole('option')).toHaveCount(1)
    const quickOpenMs = performance.now() - searchStart
    await page.keyboard.press('Enter')
    await expect(page.locator('.breadcrumb span:last-child')).toHaveText(`${folder}/note-1199.md`)
    await report('performance', {
      at: new Date().toISOString(), build: 'Vite 生产构建嵌入 Go，本机回环 HTTP；非 Vite 开发服务',
      environment: { node: process.version, browser: page.context().browser()?.version(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model, parallelism: availableParallelism() },
      fixture: { files: count + 2, richBytes: Buffer.byteLength(richSource), textBytes: Buffer.byteLength(textSource), richSha256: createHash('sha256').update(richSource).digest('hex'), textSha256: createHash('sha256').update(textSource).digest('hex') },
      ms: { firstPageMs, pagesMs, namesMs, fullMs, richOpenMs, richInputMs, sourceOpenMs, sourceInputMs, quickOpenMs },
      note: '输入耗时含 Playwright 协议及两帧等待；三次样本不是统计学 p95。搜索 API 由 APIRequestContext 发起，快开另测实际 UI。首次编辑器打开含动态分块加载；无网络/CPU 限速。',
      exactSavedContent: true,
      budgetsMs: budgets,
    })
    // 首次本机实测后留出约两倍余量；这是该夹具的回归预算，不是跨设备 SLA。
    expect(firstPageMs).toBeLessThan(budgets.firstPage)
    expect(Math.max(...pagesMs)).toBeLessThan(budgets.nextPage)
    expect(Math.max(...namesMs, ...fullMs)).toBeLessThan(budgets.searchAPI)
    expect(Math.max(richOpenMs, sourceOpenMs)).toBeLessThan(budgets.editorOpen)
    expect(Math.max(...richInputMs, ...sourceInputMs)).toBeLessThan(budgets.input)
    expect(quickOpenMs).toBeLessThan(budgets.quickOpen)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
