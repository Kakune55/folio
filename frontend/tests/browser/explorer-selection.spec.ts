import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function setup(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  await noSelectionControls(page)
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const headers = { 'X-CSRF-Token': principal.csrfToken }
  const name = `选择-${Date.now()}-${test.info().workerIndex}`
  const create = async (path: string, directory = false, content = '# 保留原文\r\n\r\n中文 空格。\r\n') => {
    const response = await page.request.post(`/api/v1/${directory ? 'directories' : 'files'}`, {
      headers, data: directory ? { path } : { path, content },
    })
    expect(response.status(), `创建 ${path}`).toBe(201)
  }
  const read = async (path: string) => {
    const response = await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)
    expect(response.status(), `读取 ${path}`).toBe(200)
    const { content, revision } = await response.json()
    return { content, revision }
  }
  const revision = async (path: string) => {
    const response = await page.request.get(`/api/v1/entries/revision?path=${encodeURIComponent(path)}`)
    expect(response.status(), `版本 ${path}`).toBe(200)
    return (await response.json()).revision as string
  }
  const row = (path: string) => page.locator(`button[data-entry-path=${JSON.stringify(path)}]`)
  const refresh = async () => {
    const response = page.waitForResponse(response => response.url().includes('/workspace/tree?') && response.ok())
    await page.getByRole('button', { name: '刷新文件列表' }).click()
    await response
  }
  await create(name, true)
  return { name, create, read, revision, row, refresh, headers }
}

async function action(page: Page, row: Locator, name: string, context = true) {
  if (context) await row.click({ button: 'right' })
  else await row.locator('..').getByRole('button', { name: /^文件操作 / }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function createFromMenu(page: Page, target: Locator, kind: '笔记' | '文件夹', name: string, parent: string) {
  await target.click({ button: 'right' })
  await page.getByRole('menuitem', { name: `新建${kind}`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `新建${kind}`, exact: true })
  await expect(dialog.getByText(`创建位置：${parent || '工作区根目录'}`, { exact: true })).toBeVisible()
  await dialog.getByLabel('名称', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).not.toBeVisible()
}

async function selected(page: Page, paths: string[]) {
  await expect.poll(() => page.locator('button[data-entry-path][aria-pressed="true"]').evaluateAll(
    rows => rows.map(row => (row as HTMLElement).dataset.entryPath!).sort(),
  )).toEqual([...paths].sort())
  await noSelectionControls(page)
}

async function noSelectionControls(page: Page) {
  const nav = page.getByRole('navigation', { name: '工作区文件' })
  await expect(nav.getByRole('button', { name: /^(多选|完成多选)$/ })).toHaveCount(0)
  await expect(nav.getByRole('checkbox')).toHaveCount(0)
  await expect(page.locator('.tree-selection-toolbar')).toHaveCount(0)
  await expect(nav.getByText(/^已选 \d+ 项$/)).toHaveCount(0)
}

async function clearSelection(page: Page) {
  await page.getByRole('navigation', { name: '工作区文件' }).getByRole('button', { name: '工作区', exact: true }).click()
  await selected(page, [])
}

async function touchInput(page: Page) {
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  const start = async (row: Locator) => {
    await row.scrollIntoViewIfNeeded()
    const box = await row.boundingBox()
    expect(box).not.toBeNull()
    const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    return point
  }
  const end = () => session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const tap = async (row: Locator) => { await start(row); await end() }
  return { session, start, end, tap }
}

test('桌面根目录、空白和文件夹右键冻结准确创建位置，不沿用此前目录', async ({ page }) => {
  const { name, create, row, refresh, read, revision } = await setup(page)
  const previous = `${name}/此前目录`, target = `${name}/右键目标`
  await create(previous, true); await create(target, true)
  await refresh(); await row(name).click(); await row(previous).click()
  const rootNote = `${name}-根笔记.md`, rootFolder = `${name}-根文件夹`
  await createFromMenu(page, page.getByRole('button', { name: '工作区', exact: true }), '笔记', rootNote, '')
  await read(rootNote)
  await row(previous).click()
  await createFromMenu(page, page.getByRole('button', { name: '工作区', exact: true }), '文件夹', rootFolder, '')
  await revision(rootFolder)
  // 空目录提示位于 nav 内但不是条目，使用真实右键验证空白菜单的当前目录。
  await row(previous).click()
  const empty = page.getByRole('navigation', { name: '工作区文件' }).getByText('此目录还没有文件', { exact: true })
  await createFromMenu(page, empty, '文件夹', '空白创建', previous)
  await revision(`${previous}/空白创建`)
  await createFromMenu(page, row(target), '笔记', '中文 空格.md', target)
  await read(`${target}/中文 空格.md`)
  await row(previous).click()
  await createFromMenu(page, row(target), '文件夹', '子 文件夹', target)
  await revision(`${target}/子 文件夹`)
  for (const path of [`${previous}/中文 空格.md`, `${previous}/子 文件夹`, `${previous}/${rootNote}`, `${previous}/${rootFolder}`]) {
    expect((await page.request.get(`/api/v1/entries/revision?path=${encodeURIComponent(path)}`)).status()).toBe(404)
  }
})

test('复制相对路径保留中文空格原始 path，剪贴板失败可手动全选', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const { name, create, row, refresh, read } = await setup(page)
  const path = `${name}/中文 空格.md`
  await create(path); const original = await read(path)
  await refresh(); await row(name).click()
  await action(page, row(path), '复制相对路径')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(path)
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new DOMException('测试拒绝剪贴板', 'NotAllowedError') } }) })
  await action(page, row(path), '复制相对路径', false)
  const dialog = page.getByRole('dialog', { name: '复制相对路径', exact: true })
  const textarea = dialog.getByLabel('相对路径', { exact: true })
  await expect(textarea).toHaveValue(path)
  await expect(textarea).toHaveAttribute('readonly', '')
  await textarea.focus()
  await expect.poll(() => textarea.evaluate(element => {
    const input = element as HTMLTextAreaElement
    return input.value.slice(input.selectionStart, input.selectionEnd)
  })).toBe(path)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  expect(await read(path)).toEqual(original)
})

test('修饰键多选按当前可见行正反向范围，普通点击仅打开一次且选择不改正文', async ({ page }) => {
  const { name, create, row, refresh, read } = await setup(page)
  const folder = `${name}/a-目录`, hidden = `${folder}/隐藏.md`
  const notes = ['b-一.md', 'c-二.md', 'd-三.md'].map(note => `${name}/${note}`)
  await create(folder, true); await create(hidden)
  for (const path of notes) await create(path)
  const originals = await Promise.all([...notes, hidden].map(read))
  await refresh(); await row(name).click()
  await row(folder).click(); await expect(row(hidden)).toBeVisible()
  await page.getByRole('button', { name: '收起 a-目录', exact: true }).click()
  await expect(row(hidden)).toHaveCount(0)
  await clearSelection(page)
  await row(notes[0]).click({ modifiers: ['ControlOrMeta'] })
  await row(notes[2]).click({ modifiers: ['ControlOrMeta'] })
  await selected(page, [notes[0], notes[2]])
  await row(notes[0]).click({ modifiers: ['Shift'] })
  await selected(page, notes)
  await page.screenshot({ path: test.info().outputPath('explorer-multiselect-desktop.png') })
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true })).toHaveCount(0)
  await row(folder).click({ modifiers: ['ControlOrMeta'] })
  const visible = await page.getByRole('navigation', { name: '工作区文件' }).locator('button[data-entry-path]').evaluateAll(
    rows => rows.map(row => (row as HTMLElement).dataset.entryPath!),
  )
  await row(notes[2]).click({ modifiers: ['Shift'] })
  await selected(page, visible.slice(visible.indexOf(folder), visible.indexOf(notes[2]) + 1))
  await expect(page.getByRole('tab')).toHaveCount(0)
  await row(notes[1]).click({ button: 'right' })
  await expect(page.getByRole('menu').getByText(`已选 ${visible.slice(visible.indexOf(folder), visible.indexOf(notes[2]) + 1).length} 项`, { exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: '取消选择', exact: true }).click()
  await selected(page, [])
  await row(notes[0]).click({ modifiers: ['ControlOrMeta'] })
  await row(notes[1]).focus(); await page.keyboard.press('Escape')
  await selected(page, [])
  await row(notes[1]).click(); await row(notes[1]).click()
  await expect(page.getByRole('tab')).toHaveCount(1)
  await expect(page.getByRole('tab', { name: 'c-二.md', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect(await Promise.all([...notes, hidden].map(read))).toEqual(originals)
})

test('三点及右键保留选择组，未选中右键只选目标；批量移动和一次回收去重父子并带 If-Match', async ({ page }) => {
  const { name, create, row, refresh, read, revision } = await setup(page)
  const parent = `${name}/父目录`, child = `${parent}/子笔记.md`, peer = `${name}/同组.md`, other = `${name}/未选择.md`, destination = `${name}/目标目录`
  await create(parent, true); await create(child); await create(peer); await create(other); await create(destination, true)
  const original = await read(child), peerOriginal = await read(peer)
  await refresh(); await row(name).click(); await row(parent).click()
  await clearSelection(page)
  await row(parent).click({ modifiers: ['ControlOrMeta'] }); await row(child).click({ modifiers: ['ControlOrMeta'] }); await row(peer).click({ modifiers: ['ControlOrMeta'] })
  await selected(page, [parent, child, peer])
  await action(page, row(child), '移动到…', false)
  const move = page.getByRole('dialog', { name: '移动到', exact: true })
  await expect(move.locator('.operation-selection')).toHaveAttribute('title', [parent, peer].join('\n'))
  await move.getByRole('button', { name: '取消', exact: true }).click()
  await action(page, row(peer), '移动到…')
  await expect(move.locator('.operation-selection')).toHaveAttribute('title', [parent, peer].join('\n'))
  await move.getByRole('button', { name: '取消', exact: true }).click()
  await action(page, row(other), '移动到…')
  await selected(page, [other])
  await expect(move).toContainText('未选择.md')
  await expect(move.locator('input')).toHaveCount(0)
  await move.getByRole('button', { name: '取消', exact: true }).click()
  await row(other).click({ modifiers: ['ControlOrMeta'] })
  for (const path of [parent, child, peer]) await row(path).click({ modifiers: ['ControlOrMeta'] })
  const expectedRevisions = new Map([[parent, await revision(parent)], [peer, await revision(peer)]])
  const mutations: { method: string; path: string; match: string | undefined }[] = []
  page.on('request', request => {
    if (request.method() === 'PATCH' && request.url().includes('/entries/move')) mutations.push({ method: 'PATCH', path: request.postDataJSON().from, match: request.headers()['if-match'] })
    if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/v1/entries') mutations.push({ method: 'DELETE', path: new URL(request.url()).searchParams.get('path')!, match: request.headers()['if-match'] })
  })
  await action(page, row(peer), '移动到…', false)
  await move.getByRole('button', { name: `进入目录 ${name}`, exact: true }).click()
  await move.getByRole('button', { name: `进入目录 ${destination}`, exact: true }).click()
  await move.getByRole('button', { name: '移动到此', exact: true }).click()
  await expect(move).not.toBeVisible()
  expect(mutations).toEqual([parent, peer].map(path => ({ method: 'PATCH', path, match: `"${expectedRevisions.get(path)}"` })))
  const movedParent = `${destination}/父目录`, movedChild = `${movedParent}/子笔记.md`, movedPeer = `${destination}/同组.md`
  expect(await read(movedChild)).toEqual(original); expect(await read(movedPeer)).toEqual(peerOriginal)
  await row(destination).click(); await row(movedParent).click()
  await clearSelection(page)
  for (const path of [movedParent, movedChild, movedPeer]) await row(path).click({ modifiers: ['ControlOrMeta'] })
  const deleteRevisions = new Map([[movedParent, await revision(movedParent)], [movedPeer, await revision(movedPeer)]])
  await action(page, row(movedChild), '移到回收站')
  const confirmation = page.getByRole('dialog', { name: '移到回收站？', exact: true })
  await expect(confirmation.getByRole('list', { name: '剩余操作目标' }).getByRole('listitem')).toHaveText([movedParent, movedPeer])
  expect(mutations).toHaveLength(2)
  await confirmation.getByRole('button', { name: '移到回收站', exact: true }).click()
  await expect(confirmation).not.toBeVisible()
  expect(mutations.slice(2)).toEqual([movedParent, movedPeer].map(path => ({ method: 'DELETE', path, match: `"${deleteRevisions.get(path)}"` })))
  await expect(row(movedParent)).toHaveCount(0); await expect(row(movedPeer)).toHaveCount(0)
  const trash = await (await page.request.get('/api/v1/trash')).json()
  for (const path of [movedParent, movedPeer]) expect(trash.entries.filter((entry: { path: string }) => entry.path === path)).toHaveLength(1)
  expect(await read(other)).toEqual(peerOriginal)
})

for (const failure of ['412', 'abort'] as const) {
  test(`批量移动部分成功后 ${failure} 立即停止，${failure === '412' ? '仅重试剩余项' : '未知结果禁止重试'}`, async ({ page }) => {
    const { name, create, row, refresh, read, revision } = await setup(page)
    const paths = ['一.md', '二.md', '三.md'].map(note => `${name}/${note}`), destination = `${name}/目标`
    await create(destination, true)
    for (const path of paths) await create(path)
    const originals = await Promise.all(paths.map(read))
    const revisions = await Promise.all(paths.map(revision))
    await refresh(); await row(name).click()
    await clearSelection(page)
    for (const path of paths) await row(path).click({ modifiers: ['ControlOrMeta'] })
    const requests: { from: string; to: string; match: string | undefined }[] = []
    let injected = false
    await page.route('**/api/v1/entries/move', async route => {
      const request = route.request(), body = request.postDataJSON()
      requests.push({ ...body, match: request.headers()['if-match'] })
      if (body.from === paths[1] && !injected) {
        injected = true
        if (failure === 'abort') await route.abort('failed')
        else await route.fulfill({ status: 412, contentType: 'application/json', body: JSON.stringify({ error: { code: 'revision_conflict', message: '测试版本冲突，操作未执行' } }) })
      } else await route.continue()
    })
    await action(page, row(paths[0]), '移动到…')
    const dialog = page.getByRole('dialog', { name: '移动到', exact: true })
    await dialog.getByRole('button', { name: `进入目录 ${name}`, exact: true }).click()
    await dialog.getByRole('button', { name: `进入目录 ${destination}`, exact: true }).click()
    await dialog.getByRole('button', { name: '移动到此', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('已完成 1/3 项')
    await expect(dialog.getByRole('list', { name: '剩余操作目标' }).getByRole('listitem')).toHaveText(paths.slice(1))
    expect(requests.map(request => request.from)).toEqual(paths.slice(0, 2))
    expect(requests.map(request => request.match)).toEqual(revisions.slice(0, 2).map(value => `"${value}"`))
    expect(await read(`${destination}/一.md`)).toEqual(originals[0])
    for (const index of [1, 2]) expect(await read(paths[index])).toEqual(originals[index])
    expect((await page.request.get(`/api/v1/entries/revision?path=${encodeURIComponent(paths[0])}`)).status()).toBe(404)
    if (failure === '412') {
      await dialog.getByRole('button', { name: '移动到此', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      expect(requests.map(request => request.from)).toEqual([paths[0], paths[1], paths[1], paths[2]])
      for (const [index, path] of paths.entries()) expect(await read(`${destination}/${path.split('/').at(-1)}`)).toEqual(originals[index])
    } else {
      await expect(dialog.getByRole('alert')).toContainText('本次操作结果未知，禁止直接重试')
      await expect(dialog.locator('fieldset')).toHaveAttribute('disabled', '')
      await expect(dialog.locator('input')).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: '工作区根目录', exact: true })).toBeDisabled()
      await expect(dialog.getByRole('button', { name: '刷新目标目录', exact: true })).toBeDisabled()
      await expect(dialog.getByRole('button', { name: '移动到此', exact: true })).toBeDisabled()
      await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeEnabled()
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      expect(requests).toHaveLength(2)
    }
  })
}

for (const width of [390, 320]) {
  test(`手机 ${width} 原生长按选择与整组菜单，点按增减不打开，明暗无溢出和定向 axe`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { name, create, row, refresh, read } = await setup(page)
    const folder = `${name}/手机目录`, path = `${folder}/中文 空格.md`, peer = `${folder}/另一篇.md`
    await create(folder, true); await create(path); await create(peer)
    const originals = await Promise.all([path, peer].map(read))
    const nav = page.getByRole('navigation', { name: '工作区文件' })
    if (!await nav.isVisible()) await page.getByRole('button', { name: '展开文件列表', exact: true }).click()
    await refresh(); await row(name).click(); await row(folder).click()
    const touch = await touchInput(page)
    // 移动并取消的真实触摸不能误触发长按选择或正文打开。
    const point = await touch.start(row(path))
    await touch.session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - 40 }] })
    await touch.session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    await selected(page, [])
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveCount(0)
    await touch.start(row(path))
    await expect(row(path)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await touch.end()
    await selected(page, [path])
    await touch.tap(row(peer)); await selected(page, [path, peer])
    await touch.tap(row(peer)); await selected(page, [path])
    await touch.tap(row(peer)); await selected(page, [path, peer])
    await expect(nav).toBeVisible(); await expect(row(path)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true })).toHaveCount(0)
    await touch.start(row(path))
    await expect(page.getByRole('menu').getByText('已选 2 项', { exact: true })).toBeVisible()
    await touch.end()
    await selected(page, [path, peer])
    await page.getByRole('menuitem', { name: '取消选择', exact: true }).click()
    await selected(page, [])
    await expect(nav).toBeVisible()
    await touch.start(row(path))
    await expect(row(path)).toHaveAttribute('aria-pressed', 'true')
    await touch.end()
    await touch.tap(row(peer))
    await row(path).locator('..').getByRole('button', { name: '文件操作 中文 空格.md', exact: true }).click()
    await expect(page.getByRole('menu').getByText('已选 2 项', { exact: true })).toBeVisible()
    await page.getByRole('menuitem', { name: '取消选择', exact: true }).click()
    await selected(page, [])
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (width === 390) expect((await new AxeBuilder({ page }).include('nav[aria-label="工作区文件"]').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([])
      await row(folder).locator('..').getByRole('button', { name: '文件操作 手机目录', exact: true }).click()
      for (const label of ['新建笔记', '新建文件夹', '复制相对路径']) await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
      const box = await page.getByRole('menu').boundingBox()
      expect(box && box.x >= 0 && box.x + box.width <= width).toBeTruthy()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (width === 390) expect((await new AxeBuilder({ page }).include('[role="menu"]').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([])
      if (theme === 'dark') await page.screenshot({ path: test.info().outputPath(`explorer-menu-mobile-${width}.png`) })
      await page.keyboard.press('Escape')
    }
    await clearSelection(page)
    await expect(nav).toBeVisible()
    await touch.tap(row(path))
    await expect(page.getByRole('tab', { name: '中文 空格.md', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(nav).not.toBeVisible()
    expect(await Promise.all([path, peer].map(read))).toEqual(originals)
    await touch.session.detach()
  })
}

for (const type of ['move', 'delete'] as const) {
  test(`确认期间文件被另一客户端替换成目录时拒绝${type === 'move' ? '移动' : '回收'}，不沿用新目录版本`, async ({ page }) => {
    const { name, create, row, refresh, read, revision, headers } = await setup(page)
    const source = `${name}/原文件.md`, retained = `${name}/保留原文.md`, child = `${source}/不可误操作.md`
    await create(source)
    const original = await read(source)
    await refresh(); await row(name).click()
    await action(page, row(source), type === 'move' ? '移动到…' : '移到回收站')
    const dialog = page.getByRole('dialog', { name: type === 'move' ? '移动到' : '移到回收站？', exact: true })
    if (type === 'move') {
      await dialog.getByRole('button', { name: '工作区根目录', exact: true }).click()
    }
    const moved = await page.request.patch('/api/v1/entries/move', { headers: { ...headers, 'If-Match': `"${original.revision}"` }, data: { from: source, to: retained } })
    expect(moved.status()).toBe(200)
    await create(source, true); await create(child, false, '新目录中的正文\n')
    await expect(row(source)).toHaveAttribute('aria-expanded', 'false')
    const mutations: string[] = []
    page.on('request', request => { if (['PATCH', 'DELETE'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/v1/entries')) mutations.push(request.url()) })
    const submit = dialog.getByRole('button', { name: type === 'move' ? '移动到此' : '移到回收站', exact: true })
    await submit.click()
    await expect(dialog.getByRole('alert')).toContainText('类型已变化')
    await expect(submit).toBeDisabled()
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeEnabled()
    expect(mutations).toEqual([])
    expect((await read(child)).content).toBe('新目录中的正文\n')
    expect(await read(retained)).toEqual(original)
    await revision(source)
  })
}
