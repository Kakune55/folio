// 只连接本次临时容器；测试原件、草稿和浏览器配置不会写入日常工作区。
import { chromium, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const url = process.env.FOLIO_REVIEW_URL
const data = process.env.FOLIO_REVIEW_DATA
const spki = process.env.FOLIO_REVIEW_SPKI
if (!url || !data || !spki || !process.env.FOLIO_REVIEW_PASSWORD) throw new Error('缺少隔离审查配置')
const marker = JSON.parse(await readFile(path.join(data, 'review-marker.json'), 'utf8'))
if (marker.url !== url || marker.nonce !== process.env.FOLIO_REVIEW_NONCE || !path.basename(data).startsWith('folio-container-review-') || new URL(url).hostname !== '127.0.0.1' || new URL(url).protocol !== 'https:') throw new Error('拒绝连接非本次隔离 HTTPS 容器')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const context = await chromium.launchPersistentContext(path.join(data, 'browser-profile'), { executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', `--ignore-certificate-errors-spki-list=${spki}`], ignoreHTTPSErrors: false, viewport: { width: 1440, height: 900 } })
const page = context.pages()[0] ?? await context.newPage()
const errors = [], alerts = [], external = []
const checks = {}
const started = new Date().toISOString()
page.on('pageerror', (error) => errors.push(error.message))
page.on('dialog', async (dialog) => { if (dialog.type() !== 'beforeunload') alerts.push(dialog.type()); await dialog.accept() })
await context.route('**/*', async (route) => {
  const request = route.request(), origin = new URL(request.url()).origin
  if (origin === url) return route.continue()
  external.push({ origin, cookie: !!request.headers().cookie, referer: !!request.headers().referer })
  if (origin === 'https://example.invalid') return route.fulfill({ contentType: 'text/html', body: '<title>隔离外链目标</title>' })
  return route.abort()
})
await page.addInitScript(() => { window.policyFailures = []; document.addEventListener('securitypolicyviolation', (event) => window.policyFailures.push({ directive: event.effectiveDirective, blocked: event.blockedURI })) })
const api = (method, route, body, headers = {}) => page.evaluate(async ({ method, route, body, headers }) => {
  const principal = await (await fetch('/api/v1/auth/me')).json()
  const response = await fetch('/api/v1' + route, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': principal.csrfToken, 'X-Folio-Workspace': principal.workspaceId, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) }
}, { method, route, body, headers })
try {
  const landing = await page.goto(url)
  expect(landing.headers()['content-security-policy']).toContain("script-src 'self'")
  expect(landing.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
  await page.getByLabel('密码', { exact: true }).fill(process.env.FOLIO_REVIEW_PASSWORD)
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
  const cookie = (await context.cookies()).find((value) => value.name === 'folio_session')
  expect(cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict').toBe(true)
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true)
  await page.evaluate(() => { const script = document.createElement('script'); script.textContent = 'window.__FOLIO_INLINE_PROBE = 1'; document.head.append(script); script.remove() })
  await expect.poll(() => page.evaluate(() => window.policyFailures.some((item) => item.directive === 'script-src-elem' && item.blocked === 'inline'))).toBe(true)
  expect(await page.evaluate(() => window.__FOLIO_INLINE_PROBE)).toBeUndefined()
  checks.inlineScriptBlockedByProductionCSP = true
  await page.evaluate(() => { const script = document.createElement('script'); script.src = 'https://exfil.invalid/script.js'; document.head.append(script) })
  await expect.poll(() => page.evaluate(() => window.policyFailures.some((item) => item.directive === 'script-src-elem' && item.blocked.startsWith('https://exfil.invalid')))).toBe(true)
  checks.externalScriptBlockedByProductionCSP = true
  console.log('生产 CSP 内联脚本阻断：通过')
  const fixtures = [
    ['恶意.html', '<!doctype html><script>window.__FOLIO_XSS=1</script><img src=x onerror="window.__FOLIO_XSS=2">', 'text/html'],
    ['恶意.svg', '<svg xmlns="http://www.w3.org/2000/svg" id="untrusted-svg" onload="window.__FOLIO_XSS=3"></svg>', 'image/svg+xml'],
    ['恶意.md', '---\ntitle: 保留原文\n---\n\n<script>window.__FOLIO_XSS=4</script>\n', 'text/markdown'],
  ]
  for (const [name, source, type] of fixtures) {
    const upload = await page.evaluate(async ({ name, source, type }) => {
      const me = await (await fetch('/api/v1/auth/me')).json(), body = new FormData()
      body.append('file', new File([source], name, { type }))
      const response = await fetch('/api/v1/uploads?directory=', { method: 'POST', headers: { 'X-CSRF-Token': me.csrfToken }, body })
      return response.status
    }, { name, source, type })
    expect(upload).toBe(201)
    await page.getByRole('button', { name: '刷新文件列表' }).click()
    await page.getByRole('button', { name, exact: true }).click()
    await expect(page.getByRole('textbox', { name: '源码编辑器' })).toContainText('window.__FOLIO_XSS')
    expect(await page.evaluate(() => window.__FOLIO_XSS)).toBeUndefined()
    const content = await api('GET', '/files/content?path=' + encodeURIComponent(name))
    expect(content.body.content).toBe(source)
    expect((await api('GET', '/files/preview?path=' + encodeURIComponent(name))).status).toBe(415)
    const headers = await page.evaluate(async (name) => { const response = await fetch('/api/v1/files/download?path=' + encodeURIComponent(name)); await response.arrayBuffer(); return Object.fromEntries(response.headers) }, name)
    expect(headers['content-type']).toBe('application/octet-stream')
    expect(headers['content-disposition']).toMatch(/^attachment;/)
    expect(headers['content-security-policy']).toContain('sandbox')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['cross-origin-resource-policy']).toBe('same-origin')
    const pending = page.waitForEvent('download')
    await page.evaluate((name) => { const link = document.createElement('a'); link.href = '/api/v1/files/download?path=' + encodeURIComponent(name); link.download = name; document.body.append(link); link.click(); link.remove() }, name)
    const download = await pending
    expect(await readFile(await download.path(), 'utf8')).toBe(source)
  }
  checks.untrustedHTMLSVGMarkdown = { sourcePreserved: true, previewRejected: true, isolatedOriginalDownloads: true, hashes: fixtures.map(([name, source]) => ({ name, sha256: hash(source) })) }
  console.log('HTML/SVG/Markdown 原文与下载隔离：通过')
  const linkSource = '[危险](javascript:alert%281%29)\n\n[安全外链](https://example.invalid/)\n\n[本地](./target.md)\n\n![远程图片](https://exfil.invalid/track.png)\n'
  expect((await api('POST', '/files', { path: 'links.md', content: linkSource })).status).toBe(201)
  expect((await api('POST', '/files', { path: 'target.md', content: '本地目标。\n' })).status).toBe(201)
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name: 'links.md', exact: true }).click()
  const rich = page.getByRole('textbox', { name: 'Markdown 富文本编辑器' })
  await expect(rich).toBeVisible()
  const danger = rich.locator('a').filter({ hasText: '危险' })
  expect(await danger.getAttribute('href')).not.toMatch(/^javascript:/i)
  await danger.click(); await danger.click({ button: 'middle' })
  for (const other of context.pages()) if (other !== page) await other.close()
  const popup = context.waitForEvent('page')
  await rich.getByRole('link', { name: '安全外链', exact: true }).click()
  const other = await popup
  await other.waitForLoadState('domcontentloaded')
  expect(await other.evaluate(() => window.opener)).toBeNull()
  await other.close()
  expect(external.some((entry) => entry.origin === 'https://example.invalid')).toBe(true)
  expect(external.some((entry) => entry.origin !== 'https://example.invalid' || entry.cookie || entry.referer)).toBe(false)
  expect(await rich.locator('.folio-markdown-image').getAttribute('src')).toBeNull()
  await rich.getByRole('link', { name: '本地', exact: true }).click()
  await expect(page.locator('.breadcrumb span:last-child')).toHaveText('target.md')
  expect((await api('GET', '/files/content?path=links.md')).body.content).toBe(linkSource)
  checks.linkNavigation = { unsafeHrefNeutralized: true, primaryAndAuxiliaryClick: true, localTab: true, noopener: true, noExternalCookieOrReferrer: true, remoteImageNotRequested: true, markdownUnchanged: true }
  const anonymous = await context.browser().newContext({ ignoreHTTPSErrors: false })
  try {
    const tab = await anonymous.newPage()
    for (const endpoint of ['/files/content', '/files/download', '/files/preview']) expect((await tab.goto(url + '/api/v1' + endpoint + '?path=' + encodeURIComponent('恶意.html'))).status()).toBe(401)
  } finally { await anonymous.close() }
  await page.bringToFront()
  checks.anonymousFileRequestsRejected = true
  console.log('链接、匿名读取与跨站泄漏检查：通过')
  expect((await api('POST', '/files', { path: '占位.bin', content: 'F'.repeat(400 * 1024) })).status).toBe(201)
  const original = '磁盘上的原始完整正文。\n'.repeat(700)
  const draft = '磁盘满时也不能丢失的正文。request_id\n'.repeat(4000)
  expect(Buffer.byteLength(draft)).toBeLessThan(256 * 1024)
  expect((await api('POST', '/files', { path: '磁盘满.log', content: original })).status).toBe(201)
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await page.getByRole('button', { name: '磁盘满.log', exact: true }).click()
  const source = page.getByRole('textbox', { name: '源码编辑器' })
  await expect(page.locator('.breadcrumb span:last-child')).toHaveText('磁盘满.log')
  await expect(source).toBeVisible()
  // 虚拟化编辑器只渲染可见行；用一次真实输入替换正文，避免 fill 的 DOM 选择重试。
  await source.focus(); await page.keyboard.press('Control+a'); await page.keyboard.insertText(draft)
  const failure = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/files/content?'))
  await page.keyboard.press('Control+s')
  expect((await failure).status()).toBe(500)
  await expect(page.locator('.save-status')).toContainText('保存失败')
  expect((await api('GET', '/files/content?path=' + encodeURIComponent('磁盘满.log'))).body.content).toBe(original)
  await expect(page.getByText('本机恢复副本已更新', { exact: true })).toBeVisible()
  let pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载当前草稿' }).click()
  expect(await readFile(await (await pending).path(), 'utf8')).toBe(draft)
  await page.reload()
  await page.getByRole('button', { name: '查看浏览器恢复稿' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button').filter({ hasText: '磁盘满.log' }).click()
  await expect(dialog.getByLabel('浏览器草稿正文')).toHaveValue(draft)
  await expect(dialog.getByLabel('当前磁盘正文')).toHaveValue(original)
  await dialog.getByRole('button', { name: '打开为待确认草稿' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByText('浏览器恢复稿已加载，请核对正文后手动保存', { exact: true })).toBeVisible()
  expect((await api('GET', '/files/content?path=' + encodeURIComponent('磁盘满.log'))).body.content).toBe(original)
  const filler = await api('GET', '/entries/revision?path=' + encodeURIComponent('占位.bin'))
  expect((await api('DELETE', '/entries?path=' + encodeURIComponent('占位.bin'), undefined, { 'If-Match': '"' + filler.body.revision + '"' })).status).toBe(200)
  await page.getByRole('button', { name: '保存当前文件' }).click()
  await expect(page.locator('.save-status')).toHaveText('已保存')
  expect((await api('GET', '/files/content?path=' + encodeURIComponent('磁盘满.log'))).body.content).toBe(draft)
  checks.diskFullRecovery = { failedWrite500: true, originalUnchanged: true, completeDraftDownload: true, actualReloadIndexedDBRecovery: true, explicitPausedRestore: true, reclaimThroughTrash: true, subsequentConditionalSave: true, originalSha256: hash(original), draftSha256: hash(draft), draftBytes: Buffer.byteLength(draft) }
  expect(alerts).toEqual([]); expect(errors).toEqual([])
  const violations = await page.evaluate(() => window.policyFailures)
  // 刷新会重置探针数组；实际阻断已在刷新前独立断言。
  expect(violations).toEqual([])
  await writeFile(path.join(data, 'browser-review.json'), JSON.stringify({ at: started, browser: context.browser().version(), ignoreHTTPSErrors: false, certificateException: '仅临时测试证书的 SPKI', checks, unexpectedPageErrors: errors, unexpectedDialogs: alerts }, null, 2))
  console.log('HTTPS 生产浏览器安全与 ENOSPC 恢复：通过')
} catch (error) {
  const directory = path.resolve('..', 'artifacts/security')
  await page.screenshot({ path: path.join(directory, 'review-failure.png') }).catch(() => {})
  const state = await page.evaluate(() => ({ visibility: document.visibilityState, breadcrumb: document.querySelector('.breadcrumb')?.textContent, editors: [...document.querySelectorAll('.cm-content')].map((element) => ({ html: element.outerHTML.slice(0, 500), ancestors: [element, element.parentElement, element.parentElement?.parentElement, element.closest('.editor-scroll')].filter(Boolean).map((node) => ({ tag: node.tagName, className: node.className, inert: node.inert, display: getComputedStyle(node).display, height: node.getBoundingClientRect().height })) })) })).catch(() => ({}))
  await writeFile(path.join(directory, 'review-failure.json'), JSON.stringify(state, null, 2))
  console.error(String(error).slice(0, 1200))
  process.exitCode = 1
} finally { await context.close() }
