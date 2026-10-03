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
/** Admin chrome as it sits in the HTML: aria-labels, the title template, the sidebar. */
const ADMIN_HTML = [
  'Admin panel',
  'Pages in the admin area',
  'admin — overview',
  ' · Admin</title>',
  'Back to your account',
  'Records shown',
]
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
  const html = await page.content()
  for (const words of ADMIN_HTML) expect(html, `${path} holds "${words}"`).not.toContain(words)
}

/** A response's headers less the ones that differ between any two answers. */
const comparable = (headers: Record<string, string>) => {
  const { date: _date, 'set-cookie': _cookies, ...rest } = headers
  return rest
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

  test('a page under /admin named like an image is gated too: the same plain 404', async ({
    page,
    request,
  }) => {
    // The proxy skips static files by extension; /admin is matched on its own (§2.3).
    for (const path of ['/admin/orders/x.png', '/admin/orders/x.svg', '/admin/domains/a.webp']) {
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.status(), path).toBe(404)
      const html = await response.text()
      for (const words of ADMIN_HTML) expect(html, `${path} holds "${words}"`).not.toContain(words)
    }
    await expectNotFound(page, '/admin/orders/x.png')
  })

  test("a stranger's 404 at /admin carries exactly the headers of any other 404 (D9)", async ({
    request,
  }) => {
    // Compared with a path nobody has: nothing in the answer may say /admin is
    // special — no X-Robots-Tag, no admin Cache-Control, no nonce, no rewrite.
    const elsewhere = await request.get(`/no-such-page-${Date.now().toString(36)}`, {
      maxRedirects: 0,
    })
    expect(elsewhere.status()).toBe(404)
    const expected = comparable(elsewhere.headers())
    for (const path of ['/admin', '/admin/refunds', '/admin/orders/x.png']) {
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.status(), path).toBe(404)
      const headers = response.headers()
      expect(comparable(headers), path).toEqual(expected)
      expect(headers['x-robots-tag'], path).toBeUndefined()
      expect(headers['x-middleware-rewrite'], path).toBeUndefined()
      expect(scriptSrc(headers['content-security-policy'] ?? ''), path).not.toMatch(/'nonce-/)
    }
  })

  test('the rest of the site keeps its own CSP', async ({ request }) => {
    // Present, and the site's own (next.config.ts): a NOT_ADMIN source that
    // stopped matching would leave these pages with no policy at all.
    for (const path of ['/', '/legal/privacy']) {
      const csp = (await request.get(path)).headers()['content-security-policy'] ?? ''
      const directives = new Map(
        csp.split(';').map((part) => {
          const [name = '', ...sources] = part.trim().split(/\s+/)
          return [name, sources.join(' ')] as const
        }),
      )
      expect(csp, path).not.toBe('')
      expect(directives.get('default-src'), path).toBe("'self'")
      // Cloudflare Turnstile (SEC-9): its script, and the frame it draws.
      expect(directives.get('frame-src'), path).toBe('https://challenges.cloudflare.com')
      expect(scriptSrc(csp), path).not.toMatch(/'nonce-/)
      expect(scriptSrc(csp), path).toContain("'unsafe-inline'")
      expect(scriptSrc(csp), path).toContain('https://challenges.cloudflare.com')
      expect(directives.get('frame-ancestors'), path).toBe("'none'")
      expect(directives.get('object-src'), path).toBe("'none'")
    }
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
      // Signed in, the headers too are any other 404's (D9).
      const elsewhere = await page.request.get(`/no-such-page-${Date.now().toString(36)}`)
      const atAdmin = await page.request.get('/admin/refunds')
      expect(atAdmin.status()).toBe(404)
      expect(comparable(atAdmin.headers())).toEqual(comparable(elsewhere.headers()))

      // Signed in, /sign-in?next=/admin goes to /admin — which is still a 404.
      await page.goto('/sign-in?next=/admin')
      await expect(page).toHaveURL(/\/admin$/)
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    })
  })
})

test.describe('an enrolled admin', () => {
  let admin: AdminUser | undefined

  test.beforeEach(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migration 40 is not applied to this database')
    admin = (await createAdminTestUser('admin')) as AdminUser
  })
  test.afterEach(async () => {
    if (admin) await deleteTestUser(admin.user.id)
    admin = undefined
  })

  test('reaches the dashboard after the code, on the test side, with the page marked', async ({
    page,
  }) => {
    if (!admin) throw new Error('no admin')
    await signInAsAdmin(page, admin, '/admin')

    await expect(page.getByRole('heading', { level: 1, name: 'Operations' })).toBeVisible()
    await expect(page.getByRole('note').filter({ hasText: TEST_ADMIN_BANNER })).toBeVisible()

    // An admin's answers are unindexed, uncached, under a fresh nonce CSP with no unsafe-inline (§2.3).
    const nonces = new Set<string>()
    for (const path of ['/admin', '/admin/refunds']) {
      const headers = (await page.request.get(path, { maxRedirects: 0 })).headers()
      expect(headers['x-robots-tag'], path).toBe('noindex, nofollow')
      expect(headers['cache-control'], path).toContain('no-store')
      const csp = headers['content-security-policy'] ?? ''
      expect(scriptSrc(csp), path).toMatch(/'nonce-[A-Za-z0-9+/=_-]{16,}'/)
      expect(scriptSrc(csp), path).toContain("'strict-dynamic'")
      expect(scriptSrc(csp), path).not.toContain("'unsafe-inline'")
      expect(csp, path).toContain("object-src 'none'")
      expect(csp, path).toContain("base-uri 'none'")
      expect(csp, path).toContain("frame-ancestors 'none'")
      nonces.add(scriptSrc(csp).match(/'nonce-([^']+)'/)?.[1] ?? '')
    }
    expect(nonces.size).toBe(2)
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
    if (!admin) throw new Error('no admin')
    await signInAsAdmin(page, admin, '/admin')
    await page.goto('/sign-in?next=/admin')
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Operations' })).toBeVisible()
  })

  test('a session without the code is sent to enter it', async ({ page }) => {
    if (!admin) throw new Error('no admin')
    await page.goto('/sign-in')
    const form = page.getByRole('form', { name: 'Sign in', exact: true })
    await form.getByLabel('Email').fill(admin.user.email)
    await form.getByLabel('Password', { exact: true }).fill(admin.user.password)
    await form.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/\/verify/)

    await page.goto('/admin/audit')
    await expect(page).toHaveURL(/\/verify\?next=%2Fadmin%2Faudit$/)
  })
})
