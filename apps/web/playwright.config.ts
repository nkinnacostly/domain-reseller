import { defineConfig, devices } from '@playwright/test'

/**
 * Port 3100, not 3000: Playwright reuses whatever answers on its port, and a
 * dev server on 3000 talks to the real gateway — which talks to the live
 * supplier. Tests get their own server, wired to a mock gateway (N12).
 */
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
// Both ports can move, so two checkouts of the repo can run e2e side by side.
const MOCK_GATEWAY_PORT = Number(process.env.MOCK_GATEWAY_PORT ?? 8788)
const MOCK_GATEWAY = `http://127.0.0.1:${MOCK_GATEWAY_PORT}`
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  globalTeardown: './tests/e2e/support/global-teardown.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Responsive is a requirement, not an afterthought — every suite runs on all three.
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-ios', use: { ...devices['iPhone 14'] } },
    { name: 'tablet', use: { ...devices['iPad Pro 11'] } },
  ],

  webServer: [
    {
      command: 'node tests/e2e/support/mock-gateway.mjs',
      url: `${MOCK_GATEWAY}/health`,
      env: { MOCK_GATEWAY_PORT: String(MOCK_GATEWAY_PORT) },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `pnpm build && pnpm start -p ${PORT}`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      // Process env wins over .env, so the app can only reach the mock.
      env: {
        GATEWAY_URL: MOCK_GATEWAY,
        FLUTTERWAVE_API_URL: `${MOCK_GATEWAY}/flw/v3`,
        // Payment return addresses must point back at this server, not :3000.
        NEXT_PUBLIC_APP_URL: baseURL,
      },
    },
  ],
})
