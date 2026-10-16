import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('folio-browser-test-password-2026')
  await page.getByRole('button', { name: '进入工作区' }).click()
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
}

export async function fixtureRoot() {
  const root = await realpath((await readFile(resolve('../artifacts/browser-workspace-path'), 'utf8')).trim())
  const temp = await realpath(tmpdir())
  if (basename(root) !== 'workspace' || dirname(dirname(root)) !== temp || !basename(dirname(root)).startsWith('folio-e2e-')) throw new Error('QA 只能操作本次隔离测试工作区')
  return root
}

export async function report(name: string, value: unknown) {
  const directory = resolve('../artifacts/qa')
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}
