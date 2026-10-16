import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { login, report } from './helpers'
import { resolve } from 'node:path'

for (const mobile of [false, true]) for (const theme of ['light', 'dark'] as const) {
  test(`${theme === 'light' ? '浅色' : '深色'}${mobile ? '手机' : '桌面'}：语义、对比度与键盘焦点`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    const results: unknown[] = []
    const editorSemantics = async (name: string) => {
      // 使用 Chromium 的真实 AX 树。Playwright 的局部 ariaSnapshot 会折叠部分 textbox 子项。
      const client = await page.context().newCDPSession(page)
      try {
        const { nodes } = await client.send('Accessibility.getFullAXTree')
        const editor = nodes.find((node) => node.role?.value === 'textbox' && node.name?.value === name)
        expect(editor?.ignored).toBe(false)
        const index = new Map(nodes.map((node) => [node.nodeId, node]))
        const seen = new Set<string>()
        const collect = (id: string): string => {
          if (seen.has(id)) return ''
          seen.add(id)
          const node = index.get(id)
          if (!node) return ''
          return [node.ignored ? '' : String(node.name?.value ?? '') + String(node.value?.value ?? ''), ...(node.childIds ?? []).map(collect)].join('\n')
        }
        return { role: editor?.role?.value, name: editor?.name?.value, value: editor?.value?.value, description: editor?.description?.value, text: editor ? collect(editor.nodeId) : '' }
      } finally { await client.detach() }
    }
    const scan = async (state: string) => {
      const value = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      const detail = { state, violations: value.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) })), incomplete: value.incomplete.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })) }
      results.push(detail)
      await report(`accessibility-${theme}-${mobile ? 'mobile' : 'desktop'}`, { at: new Date().toISOString(), browser: page.context().browser()?.version(), theme, mobile, results })
      expect(detail.violations, `${state}：${JSON.stringify(detail.violations)}`).toEqual([])
    }
    await page.goto('/')
    await scan('登录')
    await login(page)
    await scan('工作区')
    const principal = await (await page.request.get('/api/v1/auth/me')).json()
    const name = `无障碍-${theme}-${mobile ? '手机' : '桌面'}.md`
    expect((await page.request.post('/api/v1/files', { headers: { 'X-CSRF-Token': principal.csrfToken }, data: { path: name, content: '# 可访问的笔记\n\n键盘与读屏。\n' } })).status()).toBe(201)
    if (mobile) await page.getByRole('button', { name: '展开文件列表' }).click()
    await page.getByRole('button', { name: '刷新文件列表' }).click()
    if (mobile) await scan('手机抽屉')
    await page.getByRole('button', { name, exact: true }).click()
    const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
    await expect(rich).toBeVisible()
    await scan('富文本与标签')
    await page.screenshot({ path: resolve(`../artifacts/qa/workbench-${theme}-${mobile ? 'mobile' : 'desktop'}.png`) })
    const richSemantics = await editorSemantics('Markdown 富文本编辑器')
    expect(richSemantics.text).toContain('键盘与读屏')
    await expect(page.getByRole('tabpanel')).toHaveAccessibleName(name)
    await rich.focus()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    expect(await rich.evaluate((element) => element.contains(document.activeElement))).toBe(false)
    await page.getByRole('button', { name: '源码', exact: true }).click()
    const source = page.getByRole('textbox', { name: '源码编辑器' })
    await expect(source).toBeVisible()
    await scan('源码')
    const sourceSemantics = await editorSemantics('源码编辑器')
    expect(sourceSemantics.text).toContain('键盘与读屏')
    await report(`editor-semantics-${theme}-${mobile ? 'mobile' : 'desktop'}`, { rich: richSemantics, source: sourceSemantics })
    await source.focus()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    expect(await source.evaluate((element) => element.contains(document.activeElement))).toBe(false)
    const trigger = page.getByRole('button', { name: '快速打开文件' })
    await trigger.focus(); await page.keyboard.press('Enter')
    const search = page.getByRole('combobox')
    await expect(search).toBeFocused()
    await search.fill(name)
    await expect(page.getByRole('option')).toHaveCount(1)
    await scan('搜索')
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      expect(await page.getByRole('dialog').evaluate((element) => element.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await page.getByRole('button', { name: mobile ? '展开文件列表' : '收起文件列表' }).focus()
    if (mobile) await page.keyboard.press('Enter')
    const create = page.getByRole('button', { name: '新建笔记', exact: true }).first()
    await create.focus(); await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: '新建笔记' })).toBeVisible()
    await expect(page.getByLabel('名称', { exact: true })).toBeFocused()
    await scan('新建对话框')
    await page.keyboard.press('Escape')
    if (mobile) {
      await expect(page.getByRole('dialog', { name: '文件列表' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '展开文件列表' })).toBeFocused()
    } else await expect(create).toBeFocused()
    if (mobile) {
      const close = page.getByRole('button', { name: `关闭 ${name}`, exact: true })
      await close.focus(); await expect(close).toBeVisible(); await close.click()
    }
    else { await page.getByRole('tab', { name, exact: true }).focus(); await page.keyboard.press('Delete') }
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(page.getByRole('button', { name: mobile ? '展开文件列表' : '收起文件列表' })).toBeFocused()
    expect((await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(name)}`)).status()).toBe(200)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
