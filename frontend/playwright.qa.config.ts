import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/qa', timeout: 90_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:18081', launchOptions: { executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] } },
  webServer: {
    command: 'python3 ../scripts/test-api.py', url: 'http://127.0.0.1:18081/api/v1/healthz', timeout: 120_000,
    env: { FOLIO_TEST_ORIGIN: 'http://127.0.0.1:18081' },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
})
