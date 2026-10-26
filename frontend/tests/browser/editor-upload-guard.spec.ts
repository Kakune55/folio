import { expect, test } from '@playwright/test'
import type { CrepeBridge } from '../../src/editors/milkdown/bridge'

test('注入拒绝图片事务：上传成功后转交 detachedImage 并清理 pending，原文不变', async ({ page }) => {
  const imageRequests: string[] = []
  await page.route('**/upload-guard-image.png', async route => {
    imageRequests.push(route.request().url())
    await route.abort()
  })
  await page.goto('/?demo=1')
  await expect(page.getByRole('textbox', { name: 'Markdown 富文本编辑器', exact: true })).toBeVisible()
  const original = '保留标题\n========\n\n\n原始正文。\n'
  const result = await page.evaluate(async original => {
    // @ts-expect-error 由默认 Playwright 配置的 Vite 提供浏览器模块。
    const { createCrepe, prepareRichSource } = await import('/src/editors/milkdown/engine.ts')
    // 从 Vite 转换结果取得相同模块实例，避免另一份 ProseMirror/ctx 身份。
    const engineModule = await (await fetch('/src/editors/milkdown/engine.ts')).text()
    const dependency = (name: string) => {
      const url = [...engineModule.matchAll(/from\s*["']([^"']+)["']/g)]
        .map(match => match[1]).find(url => url.includes(name))
      if (!url) throw new Error(`找不到 Vite 依赖：${name}`)
      return url
    }
    const { Plugin } = await import(dependency('prose_state'))
    const { $prose } = await import(dependency('kit_utils'))
    const { editorViewCtx, serializerCtx } = await import(dependency('kit_core'))
    const root = document.createElement('div')
    document.body.append(root)
    let pending = 0, begins = 0, ends = 0, rejected = 0, source = original
    const uploads: { name: string; type: string; size: number }[] = []
    const detached: { url: string; alt: string }[] = []
    const errors: (string | undefined)[] = []
    const changes: string[] = []
    const imageURL = '/upload-guard-image.png'
    let finished!: () => void
    const completed = new Promise<void>(resolve => { finished = resolve })
    const bridge: CrepeBridge = {
      reference: () => undefined,
      upload: async file => { uploads.push({ name: file.name, type: file.type, size: file.size }); return imageURL },
      imageURL: url => url,
      openLink: () => { throw new Error('不应打开链接') },
      beginUpload: () => { begins++; pending++; return true },
      endUpload: () => { ends++; pending--; finished() },
      attached: () => true,
      detachedImage: (url, alt) => { detached.push({ url, alt }) },
    }
    const crepe = createCrepe(root, original, (value: string) => { source = value; changes.push(value) }, (message?: string) => errors.push(message), bridge)
    crepe.editor.use($prose(() => new Plugin({
      filterTransaction(transaction: import('@milkdown/kit/prose/state').Transaction) {
        let image = false
        transaction.doc.descendants(node => { if (node.type.name === 'image') image = true })
        if (transaction.docChanged && image) { rejected++; return false }
        return true
      },
    })))
    try {
      await crepe.create()
      const admission = prepareRichSource(crepe, original)
      if (!admission.safe) throw new Error(admission.reason ?? '原文未通过富文本准入')
      const view = crepe.editor.action((ctx: import('@milkdown/kit/ctx').Ctx) => ctx.get(editorViewCtx))
      const before = view.state.doc.toJSON()
      const serializedBefore = crepe.editor.action((ctx: import('@milkdown/kit/ctx').Ctx) => ctx.get(serializerCtx)(view.state.doc))
      const transfer = new DataTransfer()
      transfer.items.add(new File(['fake-png-upload'], 'guard.png', { type: 'image/png' }))
      // 合成剪贴板事件注入，不代表操作系统原生剪贴板验收。
      const paste = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
      view.dom.dispatchEvent(paste)
      await completed
      return {
        admission, before, after: view.state.doc.toJSON(), source, changes,
        serializedBefore,
        serializedAfter: crepe.editor.action((ctx: import('@milkdown/kit/ctx').Ctx) => ctx.get(serializerCtx)(view.state.doc)),
        pending, begins, ends, rejected, uploads, detached, errors,
        prevented: paste.defaultPrevented, images: root.querySelectorAll('img').length,
      }
    } finally {
      await crepe.destroy()
      root.remove()
    }
  }, original)
  expect(result.admission.safe).toBe(true)
  expect(result.prevented).toBe(true)
  expect(result.uploads).toEqual([{ name: 'guard.png', type: 'image/png', size: 15 }])
  expect(result.rejected).toBe(1)
  expect(result.detached).toEqual([{ url: '/upload-guard-image.png', alt: 'guard.png' }])
  expect({ begins: result.begins, ends: result.ends, pending: result.pending }).toEqual({ begins: 1, ends: 1, pending: 0 })
  expect(result.after).toEqual(result.before)
  expect(result.source).toBe(original)
  expect(result.changes.every(value => value === original)).toBe(true)
  expect(result.serializedAfter).toBe(result.serializedBefore)
  expect(result.images).toBe(0)
  expect(result.errors).toEqual(['图片已上传，当前位置无法安全插入，已追加到原笔记末尾。'])
  expect(imageRequests).toEqual([])
})

for (const [name, input] of [['极短', 'x'], ['极长', 'x'.repeat(20000)]] as const) {
test(`注入拒绝代码文本事务（${name}）：CM 恢复不二次转发，保留焦点、正文与撤销历史`, async ({ page }) => {
  const pageErrors: string[] = []
  const consoleRangeErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (/RangeError/i.test(message.text())) consoleRangeErrors.push(message.text())
  })
  await page.goto('/?demo=1')
  await expect(page.getByRole('textbox', { name: 'Markdown 富文本编辑器', exact: true })).toBeVisible()
  const original = '~~~text\noriginal_code_42\n~~~\n\n保留尾段。\n'
  const probe = await page.evaluateHandle(async original => {
    // @ts-expect-error 由默认 Playwright 配置的 Vite 提供浏览器模块。
    const { createCrepe, prepareRichSource } = await import('/src/editors/milkdown/engine.ts')
    const engineModule = await (await fetch('/src/editors/milkdown/engine.ts')).text()
    const dependency = (name: string) => {
      const url = [...engineModule.matchAll(/from\s*["']([^"']+)["']/g)]
        .map(match => match[1]).find(url => url.includes(name))
      if (!url) throw new Error(`找不到 Vite 依赖：${name}`)
      return url
    }
    const { Plugin } = await import(dependency('prose_state'))
    const { $prose } = await import(dependency('kit_utils'))
    const { editorViewCtx, serializerCtx } = await import(dependency('kit_core'))
    // @ts-expect-error Vite 转换包入口，并解析其 @milkdown/prose/history 重导出。
    const { undoDepth } = await import('/node_modules/@milkdown/kit/lib/prose/history.js')
    const root = document.createElement('div')
    root.id = 'code-rejection-probe'
    document.body.append(root)
    let source = original, rejected = 0, bodyTransactions = 0, armed = false
    const changes: string[] = []
    const errors: (string | undefined)[] = []
    const crepe = createCrepe(root, original, (value: string) => { source = value; changes.push(value) }, (message?: string) => errors.push(message))
    // 仅注入拒绝代码文本变化，初始化及 selection 等非正文事务仍被接纳。
    const codeText = (doc: import('@milkdown/kit/prose/model').Node) => {
      const blocks: string[] = []
      doc.descendants(node => { if (node.type.name === 'code_block') blocks.push(node.textContent) })
      return blocks
    }
    crepe.editor.use($prose(() => new Plugin({
      filterTransaction(transaction: import('@milkdown/kit/prose/state').Transaction, state: import('@milkdown/kit/prose/state').EditorState) {
        if (armed && transaction.docChanged) bodyTransactions++
        if (transaction.docChanged && JSON.stringify(codeText(transaction.doc)) !== JSON.stringify(codeText(state.doc))) {
          rejected++
          return false
        }
        return true
      },
    })))
    await crepe.create()
    const admission = prepareRichSource(crepe, original)
    if (!admission.safe) { await crepe.destroy(); root.remove(); throw new Error(admission.reason ?? '原文未通过富文本准入') }
    const view = crepe.editor.action((ctx: import('@milkdown/kit/ctx').Ctx) => ctx.get(editorViewCtx))
    const before = view.state.doc.toJSON()
    const serialize = () => crepe.editor.action((ctx: import('@milkdown/kit/ctx').Ctx) => ctx.get(serializerCtx)(view.state.doc))
    const serializedBefore = serialize()
    const undoBefore: number = undoDepth(view.state)
    armed = true
    return {
      snapshot: () => ({ source, changes: [...changes], errors: [...errors], rejected, bodyTransactions, before, after: view.state.doc.toJSON(), serializedBefore, serializedAfter: serialize(), undoBefore, undoAfter: undoDepth(view.state) as number }),
      destroy: async () => { await crepe.destroy(); root.remove() },
    }
  }, original)
  try {
    const code = page.locator('#code-rejection-probe .milkdown-code-block .cm-content')
    await expect(code).toHaveText('original_code_42')
    const initial = await probe.evaluate(probe => probe.snapshot())
    expect(initial.rejected).toBe(0)
    expect(initial.bodyTransactions).toBe(0)
    await code.focus()
    await expect(code).toBeFocused()
    // 真实内嵌 CM 的文本输入路径，不直接 dispatch 伪造 PM 修改。
    await code.fill(input)
    await expect.poll(async () => (await probe.evaluate(probe => probe.snapshot())).rejected).toBe(1)
    await expect(code).toHaveText('original_code_42')
    await expect(code).toBeFocused()
    await expect.poll(async () => (await probe.evaluate(probe => probe.snapshot())).errors)
      .toContain('代码块修改未被接纳，已恢复原代码；可切换源码编辑。')
    // 等待 Milkdown 的正文监听防抖，防止将迟到的新正文漏判为未变。
    await page.waitForTimeout(500)
    const result = await probe.evaluate(probe => probe.snapshot())
    expect(result.rejected).toBe(1)
    expect(result.bodyTransactions).toBe(1)
    expect(result.undoAfter).toBe(result.undoBefore)
    expect(result.after).toEqual(result.before)
    expect(result.source).toBe(original)
    expect(result.changes).toEqual(initial.changes)
    expect(result.changes.every(value => value === original)).toBe(true)
    expect(result.serializedAfter).toBe(result.serializedBefore)
    await expect(code).toHaveText('original_code_42')
    await expect(code).toBeFocused()
    await expect(page.locator('#code-rejection-probe .ProseMirror > p')).toHaveText('保留尾段。')
  } finally {
    await probe.evaluate(probe => probe.destroy())
    await probe.dispose()
  }
  expect(pageErrors).toEqual([])
  expect(consoleRangeErrors).toEqual([])
})
}
