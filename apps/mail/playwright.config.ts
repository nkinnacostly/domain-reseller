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
// Billing pays a mock Flutterwave (tests/e2e/support/mock-flutterwave.mjs), never
// Flutterwave itself (N12). Both ports move, for two checkouts side by side.
const MOCK_FLUTTERWAVE_PORT = Number(process.env.MOCK_FLUTTERWAVE_PORT ?? 4301)
const MOCK_FLUTTERWAVE = `http://127.0.0.1:${MOCK_FLUTTERWAVE_PORT}`
// Made-up test values, not secrets: the mock accepts only `_TEST-` keys, and
// process env wins over .env, so the e2e server never holds a real key.
const E2E_FLUTTERWAVE_KEY_TAIL = 'e2e-mock-key-not-a-secret'
const E2E_WEBHOOK_HASH = 'e2e-mock-webhook-hash-not-a-secret'
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA'
const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA'

// ── MB2: a mock SES and DNS-over-HTTPS for the domains journey (MAIL-SPEC §12) ──
// The app's SES calls go to this loopback mock (MAIL_SES_ENDPOINT, refused in
// production), signed with AWS's documentation example key id and a test
// value that is no key at all; the domains page's live DNS check asks its
// resolver. Nothing here can send: the manager key never could (§4.3).
const MOCK_SES_PORT = Number(process.env.MOCK_SES_PORT ?? 4312)
const MOCK_SES_URL = `http://127.0.0.1:${MOCK_SES_PORT}`
const mockSesServer = {
  command: 'node tests/e2e/support/mock-ses.mjs',
  url: `${MOCK_SES_URL}/__health`,
  reuseExistingServer: !process.env.CI,
  timeout: 30_000,
  env: { MOCK_SES_PORT: String(MOCK_SES_PORT) },
}
// Spread last into the app's env, so these replace the empty manager key above.
const mockSesEnv: Record<string, string> = {
  MAIL_SES_ENDPOINT: MOCK_SES_URL,
  MAIL_DOH_URL: `${MOCK_SES_URL}/dns-query`,
  MAIL_SES_REGION: 'eu-west-2',
  MAIL_SES_MANAGER_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  MAIL_SES_MANAGER_SECRET_ACCESS_KEY: 'e2e only, not a key: signs nothing',
  MAIL_SES_EVENTS_TOPIC_ARN: 'arn:aws:sns:eu-west-2:111122223333:mail-ses-events',
}
// ── end MB2 ──

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
  webServer: [
    {
      command: 'node tests/e2e/support/mock-flutterwave.mjs',
      url: `${MOCK_FLUTTERWAVE}/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        MOCK_FLUTTERWAVE_PORT: String(MOCK_FLUTTERWAVE_PORT),
        // Flutterwave's renewal webhook, as Paidly forwards it here.
        MOCK_FLUTTERWAVE_WEBHOOK_URL: `${baseURL}/api/billing/flutterwave`,
        MOCK_FLUTTERWAVE_WEBHOOK_HASH: E2E_WEBHOOK_HASH,
      },
    },
    {
      command: `pnpm build && pnpm exec next start -p ${PORT}`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        FLUTTERWAVE_API_URL: `${MOCK_FLUTTERWAVE}/flw/v3`,
        FLUTTERWAVE_SECRET_KEY: `FLWSECK_TEST-${E2E_FLUTTERWAVE_KEY_TAIL}`,
        FLUTTERWAVE_WEBHOOK_HASH: E2E_WEBHOOK_HASH,
        NEXT_PUBLIC_MAIL_URL: baseURL,
        // A test pepper: e2e keys are made and hashed with it, never production's.
        MAIL_API_KEY_PEPPER: 'e2e pepper, not a secret, 0123456789',
        // No SES key of any kind in the e2e server: nothing here may send.
        MAIL_SES_MANAGER_ACCESS_KEY_ID: '',
        MAIL_SES_MANAGER_SECRET_ACCESS_KEY: '',
        // Cloudflare's documented always-pass Turnstile test keys, as the shop's
        // e2e uses (CLAUDE.md §15): the real widget and a real siteverify call,
        // answering yes without a click. A live secret would refuse their tokens.
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY,
        TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_KEY,
        // MB2: after the lines above, so the mock's example key is the only one.
        ...mockSesEnv,
      },
    },
    mockSesServer,
  ],
})
