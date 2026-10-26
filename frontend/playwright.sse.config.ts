import { defineConfig } from '@playwright/test'
import production from './playwright.qa.config'
export default defineConfig({ ...production, testDir: './tests/browser', testMatch: ['sse.spec.ts', 'sse-lists.spec.ts', 'external.spec.ts'], timeout: 60_000 })
