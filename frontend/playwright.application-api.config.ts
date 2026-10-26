import { defineConfig } from '@playwright/test'
import production from './playwright.qa.config'
export default defineConfig({ ...production, testDir: './tests/browser', testMatch: 'application-api.spec.ts' })
