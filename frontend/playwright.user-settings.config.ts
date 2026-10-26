import { defineConfig } from '@playwright/test'
import production from './playwright.qa.config'
export default defineConfig({ ...production, testDir: './tests/browser', testMatch: ['user-settings.spec.ts', 'users.spec.ts', 'system.spec.ts'] })
