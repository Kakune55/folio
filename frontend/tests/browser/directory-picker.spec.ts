import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function setup(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const principal = await (await page.request.get('/api/v1/auth/me')).json()
  const headers = { 'X-CSRF-Token': principal.csrfToken }
  const name = `目录选择-${Date.now()}-${test.info().workerIndex}`
  const create = async (path: string, directory = false, content = '\uFEFF# 中文 原文\r\n\r\n空格  与末尾。\r\n') => {
    const response = await page.request.post(`/api/v1/${directory ? 'directories' : 'files'}`, {
      headers, data: directory ? { path } : { path, content },
    })
    expect(response.status(), `创建 ${path}`).toBe(201)
  }
  const read = async (path: string) => {
    const response = await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(path)}`)
    expect(response.status(), `读取 ${path}`).toBe(200)
    const { content, revision } = await response.json()
    return { content: content as string, revision: revision as string }
  }
  const row = (path: string) => page.locator(`button[data-entry-path=${JSON.stringify(path)}]`)
  const refresh = async () => {
    await page.getByRole('button', { name: '刷新文件列表', exact: true }).click()
    await expect(row(name)).toBeVisible()
  }
  const dialog = page.getByRole('dialog', { name: '移动到', exact: true })
  const open = async (path: string) => {
    await row(path).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '移动到…', exact: true }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveClass(/entry-move-dialog/)
    await expect(dialog.getByText('高级路径输入', { exact: true })).toHaveCount(0)
    await expect(dialog.locator('input')).toHaveCount(0)
    await expect(dialog.getByText(/^当前目标目录：/)).toHaveCount(0)
  }
  const enter = async (path: string) => {
    await dialog.getByRole('button', { name: `进入目录 ${path}`, exact: true }).click()
    await expect(dialog.getByRole('navigation', { name: '目标目录路径', exact: true }).getByRole('button', { name: path.split('/').at(-1)!, exact: true })).toHaveAttribute('aria-current', 'location')
  }
  const mutations: { method: string; path: string; body: unknown; match?: string }[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if ((request.method() === 'PATCH' && path === '/api/v1/entries/move') || (request.method() === 'PUT' && path === '/api/v1/files/content')) {
      mutations.push({ method: request.method(), path, body: request.postDataJSON(), match: request.headers()['if-match'] })
    }
  })
  await create(name, true)
  return { name, create, read, row, refresh, dialog, open, enter, mutations }
}

test('单文件多层浏览、面包屑、上级和根导航零写入，确认保留原名字节及版本，根目标无需手输', async ({ page }) => {
  const { name, create, read, row, refresh, dialog, open, enter, mutations } = await setup(page)
  const source = `${name}/中文 空格.md`, target = `${name}/目标`, deep = `${target}/深层`
  await create(source); await create(target, true); await create(deep, true)
  const original = await read(source)
  await refresh(); await row(name).click()
  await open(source)
  const move = dialog.getByRole('button', { name: '移动到此', exact: true })
  await expect(move).toBeDisabled()
  await enter(target); await enter(deep)
  const crumbs = dialog.getByRole('navigation', { name: '目标目录路径', exact: true })
  await crumbs.getByRole('button', { name: '目标', exact: true }).click()
  await expect(crumbs.getByRole('button', { name: '目标', exact: true })).toHaveAttribute('aria-current', 'location')
  await dialog.getByRole('button', { name: '返回上级目录', exact: true }).click()
  await expect(move).toBeDisabled()
  await crumbs.getByRole('button', { name: '工作区根目录', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '返回上级目录', exact: true })).toBeDisabled()
  await enter(name); await enter(target); await enter(deep)
  await expect(move).toBeEnabled()
  expect(mutations).toEqual([])
  expect(await read(source)).toEqual(original)
  await move.click(); await expect(dialog).not.toBeVisible()
  const moved = `${deep}/中文 空格.md`
  expect(await read(moved)).toEqual(original)
  expect(Buffer.from((await read(moved)).content)).toEqual(Buffer.from(original.content))
  expect(mutations).toEqual([{ method: 'PATCH', path: '/api/v1/entries/move', body: { from: source, to: moved }, match: `"${original.revision}"` }])
  await row(target).click(); await row(deep).click()
  await open(moved)
  await dialog.getByRole('button', { name: '工作区根目录', exact: true }).click()
  await expect(move).toBeEnabled()
  expect(mutations).toHaveLength(1)
  await move.click(); await expect(dialog).not.toBeVisible()
  expect(await read('中文 空格.md')).toEqual(original)
  expect((await page.request.get(`/api/v1/files/content?path=${encodeURIComponent(moved)}`)).status()).toBe(404)
})

test('源目录禁止进入且原位禁用，取消后 F2 同父改名保留子文件和版本', async ({ page }) => {
  const { name, create, read, row, refresh, dialog, open, mutations } = await setup(page)
  const source = `${name}/源目录`, child = `${source}/后代`, note = `${child}/保留.md`
  await create(source, true); await create(child, true); await create(note)
  const original = await read(note)
  await refresh(); await row(name).click(); await open(source)
  const move = dialog.getByRole('button', { name: '移动到此', exact: true })
  await expect(dialog.getByRole('button', { name: `进入目录 ${source}`, exact: true })).toBeDisabled()
  await expect(move).toBeDisabled()
  await expect(dialog.getByRole('button', { name: `进入目录 ${child}`, exact: true })).toHaveCount(0)
  expect(mutations).toEqual([])
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await row(source).focus(); await page.keyboard.press('F2')
  const rename = page.getByRole('textbox', { name: '重命名 源目录', exact: true })
  await rename.fill('已改名'); await rename.press('Enter')
  await expect(row(`${name}/已改名`)).toBeVisible()
  expect(await read(`${name}/已改名/后代/保留.md`)).toEqual(original)
  expect(mutations).toHaveLength(1)
})

test('批量浏览移动保留各自原名，同名碰撞停止且不覆盖原件', async ({ page }) => {
  const { name, create, read, row, refresh, dialog, open, enter, mutations } = await setup(page)
  const target = `${name}/目标`, paths = ['一.md', '二.md'].map(file => `${name}/${file}`)
  await create(target, true)
  for (const path of paths) await create(path)
  const originals = await Promise.all(paths.map(read))
  await refresh(); await row(name).click()
  await page.getByRole('navigation', { name: '工作区文件' }).getByRole('button', { name: '工作区', exact: true }).click()
  for (const path of paths) await row(path).click({ modifiers: ['ControlOrMeta'] })
  await open(paths[0]); await enter(name)
  await expect(dialog.getByRole('button', { name: '移动到此', exact: true })).toBeDisabled()
  await enter(target)
  await expect(dialog.locator('.operation-selection')).toHaveText('已选择 2 项')
  await expect(dialog.locator('.operation-selection')).toHaveAttribute('title', paths.join('\n'))
  expect(mutations).toEqual([])
  await dialog.getByRole('button', { name: '移动到此', exact: true }).click(); await expect(dialog).not.toBeVisible()
  for (const [index, file] of ['一.md', '二.md'].entries()) expect(await read(`${target}/${file}`)).toEqual(originals[index])
  expect(mutations.map(request => request.body)).toEqual(paths.map((from, index) => ({ from, to: `${target}/${['一.md', '二.md'][index]}` })))
  for (const path of paths) await create(path, false, '碰撞源文件，不可丢失\r\n')
  await refresh()
  await page.getByRole('navigation', { name: '工作区文件' }).getByRole('button', { name: '工作区', exact: true }).click()
  for (const path of paths) await row(path).click({ modifiers: ['ControlOrMeta'] })
  await open(paths[0]); await enter(name); await enter(target)
  await dialog.getByRole('button', { name: '移动到此', exact: true }).click()
  await expect(dialog.locator('.form-error')).toContainText('同名文件或目录已存在')
  await expect(dialog.getByRole('list', { name: '剩余操作目标', exact: true }).getByRole('listitem')).toHaveText(paths)
  expect(mutations).toHaveLength(3)
  for (const [index, path] of paths.entries()) {
    expect((await read(path)).content).toBe('碰撞源文件，不可丢失\r\n')
    expect(await read(`${target}/${['一.md', '二.md'][index]}`)).toEqual(originals[index])
  }
})

test('目标目录加载中和网络失败禁止提交，明确重试成功前不发 PATCH', async ({ page }) => {
  const { name, create, read, row, refresh, dialog, open, enter, mutations } = await setup(page)
  const source = `${name}/原文.md`, target = `${name}/网络目标`
  await create(source); await create(target, true)
  const original = await read(source)
  await refresh(); await row(name).click()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let attempts = 0
  await page.route('**/api/v1/workspace/tree?*', async route => {
    if (new URL(route.request().url()).searchParams.get('path') !== target) return route.continue()
    if (++attempts === 1) { await gate; await route.abort('failed') }
    else await route.continue()
  })
  await open(source); await enter(target)
  const move = dialog.getByRole('button', { name: '移动到此', exact: true })
  try {
    await expect(dialog.getByRole('status')).toContainText('正在读取目标目录')
    await expect(move).toBeDisabled()
    expect(mutations).toEqual([])
  } finally { release() }
  const error = dialog.locator('.directory-picker').getByRole('alert')
  await expect(error).toContainText('读取目标目录失败')
  await expect(move).toBeDisabled()
  expect(mutations).toEqual([])
  expect(await read(source)).toEqual(original)
  await error.getByRole('button', { name: '重试', exact: true }).click()
  await expect(error).toHaveCount(0)
  await expect(move).toBeEnabled()
  expect(attempts).toBe(2)
  expect(mutations).toEqual([])
  await move.click(); await expect(dialog).not.toBeVisible()
  expect(await read(`${target}/原文.md`)).toEqual(original)
  expect(mutations).toHaveLength(1)
})

test('文件占满首个200条分页仍可加载后续目录，不按过滤后的目录数截断', async ({ page }) => {
  const { name, create, read, row, refresh, dialog, open, enter, mutations } = await setup(page)
  const source = `${name}/原文.md`, paged = `${name}/分页目标`, target = `${paged}/真实后续目录`
  await create(source); await create(paged, true); await create(target, true)
  const original = await read(source)
  await refresh(); await row(name).click()
  const offsets: number[] = []
  await page.route('**/api/v1/workspace/tree?*', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('path') !== paged) return route.continue()
    const offset = Number(url.searchParams.get('offset'))
    offsets.push(offset)
    expect([0, 200]).toContain(offset)
    const entries = offset === 0
      ? Array.from({ length: 200 }, (_, index) => ({ name: `文件-${index}.md`, path: `${paged}/文件-${index}.md`, kind: 'file', size: 1 }))
      : [{ name: '真实后续目录', path: target, kind: 'directory', size: 0 }]
    await route.fulfill({ json: { entries, total: 201, offset, limit: 200 } })
  })
  await open(source); await enter(paged)
  await expect(dialog.getByText('暂无文件夹，可继续加载', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('list', { name: '可浏览的目标目录', exact: true }).getByRole('button')).toHaveCount(0)
  await dialog.getByRole('button', { name: '更多目录', exact: true }).click()
  await enter(target)
  expect(offsets).toEqual([0, 200])
  expect(mutations).toEqual([])
  await dialog.getByRole('button', { name: '移动到此', exact: true }).click(); await expect(dialog).not.toBeVisible()
  expect(await read(`${target}/原文.md`)).toEqual(original)
})

test('320和390视口明暗目录弹窗无水平溢出，导航按钮可键盘操作并通过定向 axe', async ({ page }) => {
  test.setTimeout(60_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { name, create, read, row, refresh, dialog, open, mutations } = await setup(page)
  const source = `${name}/原文.md`, target = `${name}/很长的中文目标目录名称-用于窄屏边界检查-abcdefghijk`
  await create(source); await create(target, true)
  const original = await read(source)
  await refresh(); await row(name).click(); await open(source)
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      const enter = dialog.getByRole('button', { name: `进入目录 ${target}`, exact: true })
      await enter.focus(); await page.keyboard.press('Enter')
      await expect(dialog.getByRole('navigation', { name: '目标目录路径', exact: true }).getByRole('button', { name: target.split('/').at(-1)!, exact: true })).toHaveAttribute('aria-current', 'location')
      const refresh = dialog.getByRole('button', { name: '刷新目标目录', exact: true })
      await expect(refresh).toBeEnabled(); await refresh.focus(); await page.keyboard.press('Space')
      await expect(dialog.getByRole('button', { name: '移动到此', exact: true })).toBeEnabled()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect((await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([])
      await page.screenshot({ path: test.info().outputPath(`directory-picker-${width}-${theme}.png`) })
      const back = dialog.getByRole('button', { name: '返回上级目录', exact: true })
      await back.focus(); await page.keyboard.press('Enter')
      await expect(dialog.getByRole('navigation', { name: '目标目录路径', exact: true }).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'location')
      const root = dialog.getByRole('button', { name: '工作区根目录', exact: true })
      await root.focus(); await page.keyboard.press('Enter')
      await expect(dialog.getByRole('button', { name: '返回上级目录', exact: true })).toBeDisabled()
      const home = dialog.getByRole('button', { name: `进入目录 ${name}`, exact: true })
      await home.focus(); await page.keyboard.press('Enter')
      await expect(dialog.getByRole('button', { name: '移动到此', exact: true })).toBeDisabled()
    }
  }
  expect(mutations).toEqual([])
  expect(await read(source)).toEqual(original)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(mutations).toEqual([])
})
