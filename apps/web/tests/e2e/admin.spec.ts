import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import {
  createAdminTestUser,
  createTestUser,
  deleteTestUser,
  hasAdminSchema,
} from './support/accounts.mjs'
import { type AdminUser, expect, SIGN_IN_PROJECTS, signInAsAdmin, test } from './support/admin'

/**
 * The admin area's door (ADR-006, docs/ADMIN-SPEC.md §8.1). Anyone SQL does
 * not know as an admin gets a plain 404 with no admin words in it; an
 * enrolled admin — a test-only operator, on the test side — gets in only
 * after a strong sign-in and the code. The enrolled journeys need migration
 * 40 on the database and skip without it; the 404s hold either way.
 */

type TestUser = { id: string; email: string; password: string }

const ADMIN_WORDS = ['Operations', 'Audit log', 'Records shown', 'Back to your account']
const TEST_ADMIN_BANNER =
  "Test administrator: live records and customers' details are hidden, and live actions are refused."

async function expectNotFound(page: Page, path: string) {
  const response = await page.goto(path)
  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0)
  for (const words of ADMIN_WORDS) {
    await expect(page.getByText(words, { exact: true })).toHaveCount(0)
  }
}

/** The script-src directive of a CSP. */
const scriptSrc = (csp: string) =>
  csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src ')) ?? ''

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

async function overflowAt(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 })
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

test.describe('the admin area to anyone who is not an admin', () => {
  test('a signed-out visitor gets a 404 at /admin and below, and no admin words', async ({
    page,
  }) => {
    await expectNotFound(page, '/admin')
    await expectNotFound(page, '/admin/refunds')
  })

  test('every /admin answer is unindexed, uncached, and under a nonce CSP with no unsafe-inline', async ({
    request,
  }) => {
    const first = await request.get('/admin', { maxRedirects: 0 })
    const second = await request.get('/admin/refunds', { maxRedirects: 0 })
    for (const response of [first, second]) {
      const headers = response.headers()
      expect(headers['x-robots-tag']).toBe('noindex, nofollow')
      expect(headers['cache-control']).toContain('no-store')
      const csp = headers['content-security-policy'] ?? ''
      expect(scriptSrc(csp)).toMatch(/'nonce-[A-Za-z0-9+/=_-]{16,}'/)
      expect(scriptSrc(csp)).toContain("'strict-dynamic'")
      expect(scriptSrc(csp)).not.toContain("'unsafe-inline'")
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("base-uri 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
    }
    // A fresh nonce for every answer.
    const nonce = (csp: string | undefined) => scriptSrc(csp ?? '').match(/'nonce-([^']+)'/)?.[1]
    expect(nonce(first.headers()['content-security-policy'])).not.toBe(
      nonce(second.headers()['content-security-policy']),
    )
  })

  test('the rest of the site keeps its own CSP', async ({ request }) => {
    const csp = (await request.get('/')).headers()['content-security-policy'] ?? ''
    expect(csp).not.toMatch(/'nonce-/)
  })

  test('robots.txt does not name /admin', async ({ request }) => {
    const robots = await (await request.get('/robots.txt')).text()
    expect(robots).not.toContain('/admin')
  })

  test.describe('signed in', () => {
    let user: TestUser | undefined

    test.beforeEach(async () => {
      test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
      user = await createTestUser('notadmin')
    })
    test.afterEach(async () => {
      if (user) await deleteTestUser(user.id)
      user = undefined
    })

    test('a customer gets the same 404, and no admin link', async ({ page }) => {
      if (!user) throw new Error('no user')
      await page.goto('/sign-in')
      const form = page.getByRole('form', { name: 'Sign in', exact: true })
      await form.getByLabel('Email').fill(user.email)
      await form.getByLabel('Password', { exact: true }).fill(user.password)
      await form.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page).toHaveURL(/\/app\/domains/)

      await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0)
      await expectNotFound(page, '/admin')
      await expectNotFound(page, '/admin/refunds')

      // Signed in, /sign-in?next=/admin goes to /admin — which is still a 404.
      await page.goto('/sign-in?next=/admin')
      await expect(page).toHaveURL(/\/admin$/)
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    })
  })
})

test.describe('an enrolled admin', () => {
  let user: AdminUser | undefined

  test.beforeEach(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migration 40 is not applied to this database')
    user = (await createAdminTestUser('admin')) as AdminUser
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
    user = undefined
  })

  test('reaches the dashboard after the code, on the test side, with the page marked', async ({
    page,
  }) => {
    if (!user) throw new Error('no user')
    await signInAsAdmin(page, user, '/admin')

    await expect(page.getByRole('heading', { level: 1, name: 'Operations' })).toBeVisible()
    await expect(page.getByRole('note').filter({ hasText: TEST_ADMIN_BANNER })).toBeVisible()
    const nav = page.getByRole('navigation', { name: 'Admin' }).first()
    // On a phone the sidebar is a drawer.
    if (!(await nav.isVisible())) await page.getByRole('button', { name: 'Open menu' }).click()
    await expect(
      page
        .getByRole('navigation', { name: 'Admin' })
        .getByRole('link', { name: 'Overview' })
        .first(),
    ).toHaveAttribute('aria-current', 'page')
    await page
      .getByRole('navigation', { name: 'Admin' })
      .getByRole('link', { name: /^Refunds/ })
      .first()
      .click()
    await expect(page).toHaveURL(/\/admin\/refunds$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Refunds' })).toBeVisible()

    // Scripts run under the nonce: the side switch is hydrated, and a test admin cannot leave Test.
    await expect(page.getByRole('button', { name: 'Test' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Live' })).toBeDisabled()

    const results = await axe(page)
    expect(results.violations).toEqual([])
    for (const width of [320, 375, 768, 1024, 1440, 1920]) {
      expect(await overflowAt(page, width), `overflow at ${width}`).toBeLessThanOrEqual(1)
    }
  })

  test('signed in, /sign-in?next=/admin lands on /admin', async ({ page }) => {
    if (!user) throw new Error('no user')
    await signInAsAdmin(page, user, '/admin')
    await page.goto('/sign-in?next=/admin')
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Operations' })).toBeVisible()
  })

  test('a session without the code is sent to enter it', async ({ page }) => {
    if (!user) throw new Error('no user')
    await page.goto('/sign-in')
    const form = page.getByRole('form', { name: 'Sign in', exact: true })
    await form.getByLabel('Email').fill(user.email)
    await form.getByLabel('Password', { exact: true }).fill(user.password)
    await form.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/\/verify/)

    await page.goto('/admin/audit')
    await expect(page).toHaveURL(/\/verify\?next=%2Fadmin%2Faudit$/)
  })
})
