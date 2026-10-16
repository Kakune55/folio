import { defineConfig } from '@playwright/test'
export default defineConfig({
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  testDir: './tests/browser', timeout: 30_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', launchOptions: { executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] } },
  webServer: [
    { command: `${process.platform === 'win32' ? 'python' : 'python3'} ../scripts/test-api.py`, url: 'http://127.0.0.1:18081/api/v1/healthz', timeout: 120_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
    { command: 'npm run dev -- --port 5173 --strictPort', url: 'http://127.0.0.1:5173', env: { FOLIO_API_URL: 'http://127.0.0.1:18081' } },
  ],
})
