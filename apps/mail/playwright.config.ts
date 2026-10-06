import { defineConfig, devices } from '@playwright/test'

/**
 * Mail's end-to-end suite. Its own port (3301), never the dev server's
 * 3001: Playwright reuses whatever answers on its port. The send journey
 * (§12: sign up → sandbox → domain → key → send → events) arrives with the
 * packages that build it, against a mock SES — no e2e test ever calls real
 * SES (N12, for email).
 */
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3301)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests/e2e',
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
  // Responsive is a requirement: every suite on desktop, tablet and phones.
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-ios', use: { ...devices['iPhone 14'] } },
    { name: 'tablet', use: { ...devices['iPad Pro 11'] } },
  ],
  webServer: {
    command: `pnpm build && pnpm exec next start -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_MAIL_URL: baseURL,
      // A test pepper: e2e keys are made and hashed with it, never production's.
      MAIL_API_KEY_PEPPER: 'e2e-pepper-not-a-secret-0123456789abcdef',
      // No SES key of any kind in the e2e server: nothing here may send.
      MAIL_SES_MANAGER_ACCESS_KEY_ID: '',
      MAIL_SES_MANAGER_SECRET_ACCESS_KEY: '',
    },
  },
})
