import { test as base, expect, type Page } from '@playwright/test'
import { freshTotpCode } from './accounts.mjs'

/**
 * The admin suites' own `test` (ADMIN-SPEC §8.1): no screenshot, video or
 * trace, even on failure — an admin page can show a customer's details, and
 * failure artifacts are uploaded from CI. Every tests/e2e/admin*.spec.ts
 * imports `test` from here, not from @playwright/test.
 */
export const test = base.extend({
  screenshot: 'off',
  video: 'off',
  trace: 'off',
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
  await expect(page).toHaveURL(new RegExp(`${next.replaceAll('/', '\\/')}$`))
}
