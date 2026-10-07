import AxeBuilder from '@axe-core/playwright'
import type { APIResponse, Page } from '@playwright/test'
import { createTestUser, type TestUser } from './support/accounts'
import {
  type AdminUser,
  cleanUp,
  createAdminTestUser,
  createReadyAccount,
  expect,
  hasFollowupsSchema,
  hasSafetySchema,
  SIGN_IN_PROJECTS,
  seedThresholdPause,
  signInAsAdmin,
  test,
} from './support/admin'

/**
 * Mail's admin area (MAIL-SPEC §7.2, §7.4, §10, M5): a stranger gets a 404
 * indistinguishable from any other on Mail (D9); a test-only admin — on the
 * shop's gate, an e2e user — reviews an e2e account out of the sandbox, is
 * refused the live SES account, and reads a threshold pause the safety job
 * recorded. Against the hosted project; nothing calls AWS.
 */

// Every step here waits on the hosted project, whose answers can take seconds.
test.use({ reducedMotion: 'reduce' })
const slow = { timeout: 30_000 }

const WIDTHS = [320, 375, 414, 768, 1024, 1440, 1920]
/** Admin chrome as it sits in the HTML. */
const ADMIN_HTML = ['Admin panel', 'Mail admin', 'Review queue', 'SES health', 'Admin menu']

async function fitsEveryWidth(page: Page) {
  const original = page.viewportSize()
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0)
  }
  if (original) await page.setViewportSize(original)
}

async function passesAxe(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations, scheme).toEqual([])
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

async function checkPage(page: Page) {
  await passesAxe(page)
  await fitsEveryWidth(page)
}

/** The headers as sent — name, value, in order — less the two that differ between any two answers. */
const sent = (response: APIResponse) =>
  response
    .headersArray()
    .filter(({ name }) => !['date', 'set-cookie'].includes(name.toLowerCase()))
    .map(({ name, value }) => `${name}: ${value}`)

/** A document, and the requests Next's client router sends. */
const ASKED_AS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['a document', {}],
  ['a client navigation', { rsc: '1' }],
  ['a prefetch', { rsc: '1', 'next-router-prefetch': '1' }],
  [
    'a segment prefetch',
    { rsc: '1', 'next-router-prefetch': '1', 'next-router-segment-prefetch': '/_tree' },
  ],
]

const scriptSrc = (csp: string) =>
  csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src ')) ?? ''

async function expectNotFound(page: Page, path: string) {
  const response = await page.goto(path)
  expect(response?.status(), path).toBe(404)
  await expect(page.getByRole('heading', { level: 1, name: 'This page is not here' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0)
  const html = await page.content()
  for (const words of ADMIN_HTML) expect(html, `${path} holds "${words}"`).not.toContain(words)
}

const ADMIN_PATHS = [
  '/admin',
  '/admin/review',
  '/admin/accounts/0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e',
  '/admin/accounts/x.png',
]

test.describe('the admin area to anyone who is not an admin (D9)', () => {
  test('a signed-out visitor gets Mail’s plain 404 at /admin and below, an image-like name included', async ({
    page,
  }) => {
    for (const path of ADMIN_PATHS) await expectNotFound(page, path)
    await passesAxe(page)
  })

  test('the 404 carries exactly the headers of any other 404, however a browser asks', async ({
    request,
  }) => {
    for (const [way, headers] of ASKED_AS) {
      const elsewhere = await request.get(`/no-such-page-${Date.now().toString(36)}`, {
        headers,
        maxRedirects: 0,
      })
      expect(elsewhere.status(), way).toBe(404)
      const expected = sent(elsewhere)
      for (const path of ADMIN_PATHS) {
        const response = await request.get(path, { headers, maxRedirects: 0 })
        const label = `${path} as ${way}`
        expect(response.status(), label).toBe(404)
        expect(sent(response), label).toEqual(expected)
        const named = response.headers()
        expect(named['x-robots-tag'], label).toBeUndefined()
        expect(named['x-middleware-rewrite'], label).toBeUndefined()
        expect(scriptSrc(named['content-security-policy'] ?? ''), label).not.toMatch(/'nonce-/)
        const body = await response.text()
        expect(body, label).not.toContain('?path=')
        for (const words of ADMIN_HTML)
          expect(body, `${label} holds "${words}"`).not.toContain(words)
      }
    }
  })

  test('the rest of Mail keeps its own CSP, and robots.txt does not name /admin', async ({
    request,
  }) => {
    for (const path of ['/', '/pricing']) {
      const csp = (await request.get(path)).headers()['content-security-policy'] ?? ''
      expect(scriptSrc(csp), path).toContain("'unsafe-inline'")
      expect(scriptSrc(csp), path).toContain('https://challenges.cloudflare.com')
      expect(scriptSrc(csp), path).not.toMatch(/'nonce-/)
    }
    expect(await (await request.get('/robots.txt')).text()).not.toContain('/admin')
  })

  test.describe('signed in as a customer', () => {
    let customer: TestUser | undefined

    test.beforeEach(async () => {
      test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
      customer = await createTestUser('notadmin', 'Not An Admin')
    })
    test.afterEach(async () => {
      await cleanUp({ users: [customer] })
      customer = undefined
    })

    test('gets the same 404, headers and all', async ({ page }) => {
      if (!customer) throw new Error('no customer')
      await page.goto('/sign-in')
      const form = page.getByRole('form', { name: 'Sign in', exact: true })
      await form.getByLabel('Email').fill(customer.email)
      await form.getByLabel('Password', { exact: true }).fill(customer.password)
      await form.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page).toHaveURL(/\/onboarding$/, slow)
      await expectNotFound(page, '/admin')
      for (const [way, headers] of ASKED_AS) {
        const elsewhere = await page.request.get(`/no-such-page-${Date.now().toString(36)}`, {
          headers,
        })
        const atAdmin = await page.request.get('/admin/accounts', { headers })
        expect(atAdmin.status(), way).toBe(404)
        expect(sent(atAdmin), way).toEqual(sent(elsewhere))
      }
    })
  })
})

test.describe('a test admin', () => {
  test.describe.configure({ mode: 'serial' })
  let admin: AdminUser | undefined
  let owner: TestUser | undefined
  let accountId = ''
  const accountName = `MB6 Review ${Date.now().toString(36)}`

  test.beforeAll(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasSafetySchema()), 'migration 51 is not applied to this database')
    owner = await createTestUser('owner', 'Review Owner')
    accountId = await createReadyAccount(owner, accountName)
    admin = await createAdminTestUser()
  })

  test.afterAll(async () => {
    await cleanUp({ accountIds: accountId ? [accountId] : [], users: [owner, admin?.user] })
  })

  test('reviews a sandbox account out of the sandbox, is refused the live side, and reads a threshold pause', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    if (!admin) throw new Error('no admin')
    await signInAsAdmin(page, admin, '/admin')

    // The overview, under the admin's own headers (nonce CSP, unindexed, uncached).
    await expect(page.getByRole('heading', { level: 1, name: 'Mail admin' })).toBeVisible(slow)
    await expect(page.getByRole('note')).toContainText('Test administrator')
    const headers = (await page.request.get('/admin', { maxRedirects: 0 })).headers()
    expect(headers['x-robots-tag']).toBe('noindex, nofollow')
    expect(headers['cache-control']).toContain('no-store')
    expect(scriptSrc(headers['content-security-policy'] ?? '')).toMatch(
      /'nonce-[A-Za-z0-9+/=]{16,}' 'strict-dynamic'/,
    )
    expect(scriptSrc(headers['content-security-policy'] ?? '')).not.toContain("'unsafe-inline'")
    await checkPage(page)

    // An admin's account is admin-only: the dashboard sends it here.
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/admin$/, slow)

    // §7.2: the review queue shows the account ready; the test admin approves it.
    await page.goto('/admin/review')
    const card = page.locator(`[data-account="${accountId}"]`)
    await expect(card).toContainText('Ready for review', slow)
    await expect(card).toContainText(accountName)
    await checkPage(page)
    await card.getByRole('button', { name: 'Approve' }).click()
    const dialog = page.getByRole('alertdialog', { name: `Approve ${accountName}` })
    await dialog.getByLabel('Reason').fill('Website and use case checked for the e2e journey')
    await dialog.getByRole('button', { name: 'Approve the account' }).click()
    await expect(dialog.getByRole('status')).toContainText('Approved', slow)
    await dialog.getByRole('button', { name: 'Close' }).click()
    // The refreshed queue no longer holds it: it has left the sandbox.
    await expect(card).toHaveCount(0, slow)

    // The account is active and warming up; resume and caps are never a test admin's.
    await page.goto(`/admin/accounts/${accountId}`)
    await expect(page.getByRole('heading', { level: 1, name: accountName })).toBeVisible(slow)
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/Day 0: up to/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Change caps' })).toHaveCount(0)

    // The live side is refused: the SES account is not a test admin's to read.
    await page.goto('/admin/health')
    // Scoped to main: Next's route announcer is an alert too (CLAUDE.md §15).
    const refusal = page.getByRole('main').getByRole('alert')
    await expect(refusal).toContainText('This is not shown to you', slow)
    await expect(refusal).toContainText('Test administrators can')
    await checkPage(page)

    // §7.4: the safety job pauses the account at 5% bounces over 600 sends.
    const judged = await seedThresholdPause(accountId, 600, 30)
    expect(judged).toMatchObject({ ok: true, paused: true })
    await page.goto(`/admin/accounts/${accountId}`)
    await expect(page.getByText('Paused by our threshold: bounces').first()).toBeVisible(slow)
    const finding = page.locator('[data-finding="bounce_pause"]')
    await expect(finding).toContainText('Open: paused')
    await expect(finding).toContainText('Bounces 5%, complaints 0% over 7 days (600 sent)')
    await expect(page.getByRole('button', { name: 'Resume sending' })).toHaveCount(0)
    // An e2e account has no real tenant: nothing was asked of SES.
    await expect(page.getByText('Nothing has been asked of SES for this account.')).toBeVisible()
    await checkPage(page)

    // The lists and the audit log, with the approval recorded as the test admin's.
    for (const [path, heading] of [
      ['/admin/accounts?state=paused', 'Accounts'],
      ['/admin/domains', 'Domains'],
      ['/admin/audit', 'Audit log'],
    ] as const) {
      // The hosted project can be slow to answer a cold read: one more load, not a longer wait.
      await expect(async () => {
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({
          timeout: 20_000,
        })
      }).toPass({ timeout: 60_000 })
      await checkPage(page)
    }
    await expect(page.getByRole('cell', { name: 'Approve' }).first()).toBeVisible()
    await page.goto('/admin/accounts?state=paused')
    await expect(page.locator(`[data-account="${accountId}"]`)).toContainText('Paused')

    // The pages hydrate under the nonce policy: the menu opens on a phone.
    const menu = page.getByRole('button', { name: /^Menu/ })
    if (await menu.isVisible()) {
      await expect(async () => {
        await menu.click({ timeout: 1_000 })
        await expect(page.getByRole('dialog', { name: 'Admin menu' })).toBeVisible({
          timeout: 1_000,
        })
      }).toPass({ timeout: 15_000 })
    } else {
      await expect(
        page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Accounts' }),
      ).toHaveAttribute('aria-current', 'page')
    }
  })

  test('reads the billing incidents from the accounts list, test ones only (migration 54)', async ({
    page,
  }) => {
    test.skip(!(await hasFollowupsSchema()), 'migration 54 is not applied to this database')
    test.setTimeout(120_000)
    if (!admin) throw new Error('no admin')
    await signInAsAdmin(page, admin, '/admin/accounts')
    await page.getByRole('link', { name: 'Billing incidents' }).click()
    await expect(page).toHaveURL(/\/admin\/accounts\/incidents$/, slow)
    await expect(page.getByRole('heading', { level: 1, name: 'Billing incidents' })).toBeVisible(
      slow,
    )
    await expect(page.getByText('Live incidents are not shown to you.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await checkPage(page)
    await page.getByRole('link', { name: 'All', exact: true }).click()
    await expect(page).toHaveURL(/show=all$/, slow)
    await checkPage(page)
  })
})
