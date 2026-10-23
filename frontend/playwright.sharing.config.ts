import { defineConfig } from '@playwright/test'
import production from './playwright.qa.config'

// 使用真实 Go 嵌入资源和生产 CSP 运行完整分享闭环。
export default defineConfig({ ...production, testDir: './tests/browser', testMatch: 'sharing.spec.ts' })
