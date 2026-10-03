import { devNull } from 'node:os'
import { test as base, expect, type Page } from '@playwright/test'
import { freshTotpCode, totpCode } from './accounts.mjs'

/**
 * The admin suites' own `test` (ADMIN-SPEC §8.1): no screenshot, video or
 * trace, even on failure — an admin page can show a customer's details, and
 * failure artifacts are uploaded from CI. Every tests/e2e/admin*.spec.ts
 * imports `test` from here, not from @playwright/test.
 *
 * Nor an `error-context.md`: on a failure Playwright writes one into
 * test-results with the page's accessibility tree, which is the page's
 * text. It asks the test for the file's path (`testInfo.outputPath`), so
 * that one path is the null device here: nothing is written, and the
 * report's attachment is empty.
 */
export const test = base.extend<{ noErrorContext: undefined }>({
  screenshot: 'off',
  video: 'off',
  trace: 'off',
  noErrorContext: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's needs from this pattern
    async ({}, use, testInfo) => {
      const outputPath = testInfo.outputPath.bind(testInfo)
      testInfo.outputPath = (...segments: string[]) =>
        segments.length === 1 && segments[0] === 'error-context.md'
          ? devNull
          : outputPath(...segments)
      await use(undefined)
    },
    { auto: true },
  ],
})

export { expect }

/** Sign-ins are rate-limited per address: these two projects only. */
export const SIGN_IN_PROJECTS = ['chromium-desktop', 'mobile-ios']

/** What createAdminTestUser returns (ADMIN-SPEC §2.7). */
export type AdminUser = {
  user: { id: string; email: string; password: string }
  totpSecret: string
  label: string
}

/** A string matched as itself inside a RegExp: `?`, `.` and `+` are not patterns. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Signs in with the password at /sign-in?next=…, then the code on /verify. */
export async function signInAsAdmin(page: Page, admin: AdminUser, next = '/admin') {
  const { user } = admin
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/verify/)
  const verify = page.getByRole('form', { name: 'Two-factor code' })
  await verify.getByLabel('6-digit code').fill(await freshTotpCode(admin.totpSecret))
  await verify.getByRole('button', { name: 'Continue' }).click()
  // The landing address as itself: a `?` in `next` is a query, not a pattern.
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(next)}$`))
}

/** The 30-second window a time falls in. */
export const totpWindow = (ms: number = Date.now()) => Math.floor(ms / 30_000)

/**
 * A code from a later window than `after` (a time in ms): Supabase takes a
 * code once, and signing in spent that window's. Waits for a window with at
 * least five seconds left, so the code is still good when it is typed.
 */
export async function codeAfter(secret: string, after: number): Promise<string> {
  while (totpWindow() <= totpWindow(after) || 30 - ((Date.now() / 1000) % 30) < 5) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return totpCode(secret)
}

/** Six digits that are not the code now. */
export function wrongCode(secret: string): string {
  return String((Number(totpCode(secret)) + 500_000) % 1_000_000).padStart(6, '0')
}
