import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import {
  createDemoDomain,
  createTestUser,
  deleteTestUser,
  enableTotp,
  freshTotpCode,
} from './support/accounts.mjs'

/**
 * Domain management (PRD E5, E6, E7, E10) against demo domains — registration
 * is not switched on, so nothing here reaches the registrar. DNS lookups are
 * live, against public resolvers.
 */

type TestUser = { id: string; email: string; password: string }

async function signIn(page: Page, user: TestUser, next = '/app/domains') {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

test.describe('domains, signed out', () => {
  test('a domain page sends you to sign in', async ({ page }) => {
    await page.goto('/app/domains/example.com/nameservers')
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%2Fdomains%2Fexample\.com%2Fnameservers$/)
  })

  test('the expiry route lands on the 30-day view', async ({ page }) => {
    await page.goto('/app/domains/expiring')
    await expect(page).toHaveURL(/\/sign-in\?next=/)
  })
})

test.describe('portfolio', () => {
  let user: TestUser | undefined
  let names: Record<'later' | 'soon' | 'expired', string>

  test.beforeEach(async () => {
    test.skip(
      !['chromium-desktop', 'mobile-ios'].includes(test.info().project.name),
      'sign-in rate limits',
    )
    user = await createTestUser('portfolio', { fullName: 'Ada Okafor' })
    const stamp = Date.now().toString(36)
    names = {
      later: (
        await createDemoDomain(user.id, { name: `e2ecart${stamp}-later.com`, expiresInDays: 200 })
      ).name,
      soon: (
        await createDemoDomain(user.id, {
          name: `e2ecart${stamp}-soon.com`,
          expiresInDays: 12,
          autoRenew: false,
        })
      ).name,
      expired: (
        await createDemoDomain(user.id, {
          name: `e2ecart${stamp}-gone.com`,
          status: 'expired_grace',
          expiresInDays: -6,
        })
      ).name,
    }
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  // Whichever layout is showing — table on wide screens, cards on phones.
  const listed = (page: Page) =>
    page
      .locator('[data-domain]:visible')
      .evaluateAll((links) => links.map((link) => link.getAttribute('data-domain')))

  test('lists every domain, soonest expiry first, each labelled demo', async ({ page }) => {
    await signIn(page, user as TestUser)
    await expect(page).toHaveURL(/\/app\/domains$/)
    await expect.poll(() => listed(page)).toEqual([names.expired, names.soon, names.later])
    await expect(page.locator('span:visible', { hasText: /^Demo$/ }).first()).toBeVisible()
    expect((await axe(page)).violations).toEqual([])
  })

  test('the overview counts this account’s own portfolio (FR-P1)', async ({ page }) => {
    await signIn(page, user as TestUser)
    const heading = page.getByRole('heading', { level: 1 })
    await expect(heading).toHaveText(/^Good (morning|afternoon|evening), Ada$/)

    // later, soon and gone: two active, two due within 30 days (gone has
    // expired), and auto-renew on for two of the three.
    const overview = page.getByRole('region', { name: /^Good (morning|afternoon|evening), Ada$/ })
    await expect(overview.locator('dl')).toHaveText(
      /Domains\s*3\s*Active\s*2\s*Due within 30 days\s*2\s*Orders\s*0/,
    )
    await expect(
      page.getByRole('img', { name: 'Auto-renew is on for 67% of your domains (2 of 3)' }),
    ).toBeVisible()

    const comingUp = page.getByRole('region', { name: 'Coming up' })
    await expect(comingUp.getByRole('listitem').first()).toContainText(names.expired)
    await comingUp.getByRole('tab', { name: 'Orders' }).click()
    await expect(comingUp.getByText('Your orders will appear here.')).toBeVisible()
    await comingUp.getByRole('tab', { name: 'Activity' }).click()
    await expect(comingUp.getByText('Added as a demo domain').first()).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    await page.getByRole('link', { name: 'View domains due this week' }).click()
    await expect(page).toHaveURL(/within=7/)
    await expect.poll(() => listed(page)).toEqual([names.expired])
  })

  test('the sidebar holds the panel’s pages, the soonest renewals and the account', async ({
    page,
  }) => {
    await signIn(page, user as TestUser)
    await expect(page).toHaveURL(/\/app\/domains$/)

    // A drawer on phones, a sidebar on wide screens. The drawer opens once the
    // page has hydrated, so keep trying until its navigation shows.
    const drawer = page.getByRole('button', { name: 'Open menu' })
    const nav = page.getByRole('navigation', { name: 'Account' })
    await expect(async () => {
      if (!(await nav.isVisible())) await drawer.click({ timeout: 1_000 })
      await expect(nav).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByRole('link', { name: new RegExp(names.expired) }).first()).toBeVisible()

    await page.getByRole('button', { name: 'Account menu' }).click()
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()
    await page.keyboard.press('Escape')

    await nav.getByRole('link', { name: 'Orders' }).click()
    await expect(page).toHaveURL(/\/app\/orders$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Orders')
  })

  test('the 30-day view shows what needs attention, expired included (FR-P5)', async ({ page }) => {
    await signIn(page, user as TestUser)
    await page.getByRole('link', { name: 'Expiring in 30 days' }).click()
    await expect(page).toHaveURL(/within=30/)
    await expect.poll(() => listed(page)).toEqual([names.expired, names.soon])
    await expect(page.getByRole('link', { name: 'Expiring in 30 days' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  test('search narrows the list', async ({ page }) => {
    await signIn(page, user as TestUser)
    await page.getByRole('searchbox', { name: 'Search your domains' }).fill('soon')
    await page.getByRole('searchbox', { name: 'Search your domains' }).press('Enter')
    await expect.poll(() => listed(page)).toEqual([names.soon])
  })

  test('another account cannot open your domain', async ({ page }) => {
    const stranger = await createTestUser('stranger')
    try {
      await signIn(page, stranger)
      await expect(page).toHaveURL(/\/app\/domains$/)
      // The page streams, so the status is already sent; what matters is that
      // nothing of the domain is shown.
      await page.goto(`/app/domains/${names.soon}`)
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
      await expect(page.getByText(names.soon)).toHaveCount(0)
    } finally {
      await deleteTestUser(stranger.id)
    }
  })
})

test.describe('domain detail', () => {
  let user: TestUser | undefined
  let name: string

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('detail', { fullName: 'Ada Okafor' })
    name = (await createDemoDomain(user.id, { expiresInDays: 90 })).name
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('tabs mark where you are, and the overview shows the renewal price (N8)', async ({
    page,
  }) => {
    await signIn(page, user as TestUser, `/app/domains/${name}`)
    const tabs = page.getByRole('navigation', { name: 'Domain' })
    await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    // Scoped to main: after signing in, Next keeps the sign-in page hidden in
    // the DOM, and its phone mockup says "Renews at" too.
    const main = page.getByRole('main')
    await expect(main.getByText(/Renews at/)).toBeVisible()
    await expect(main.getByText(/₦[\d,]+\/yr/).first()).toBeVisible()

    await tabs.getByRole('link', { name: 'Security' }).click()
    await expect(tabs.getByRole('link', { name: 'Security' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(tabs.getByRole('link', { name: 'Overview' })).not.toHaveAttribute(
      'aria-current',
      /.*/,
    )
    await expect(page.getByText('Not editable here yet.')).toBeVisible()
    expect((await axe(page)).violations).toEqual([])
  })

  test('auto-renew changes stick and appear in the activity log', async ({ page }) => {
    await signIn(page, user as TestUser, `/app/domains/${name}`)
    const toggle = page.getByRole('switch', { name: 'Renew automatically' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    // A click before hydration does nothing; wait for the page to settle.
    await page.waitForLoadState('networkidle')
    // The switch flips at once; the save is the server action behind it.
    const saved = page.waitForResponse((response) => response.request().method() === 'POST')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await saved
    await page.reload()
    await expect(page.getByRole('switch', { name: 'Renew automatically' })).toHaveAttribute(
      'aria-checked',
      'false',
    )

    await page
      .getByRole('navigation', { name: 'Domain' })
      .getByRole('link', { name: 'Activity' })
      .click()
    await expect(page.getByRole('list', { name: 'Activity' })).toContainText(
      'Auto-renew turned off',
    )
  })

  test('changing nameservers asks for two-factor first (SEC-2)', async ({ page }) => {
    await signIn(page, user as TestUser, `/app/domains/${name}/nameservers`)
    await expect(page.getByRole('link', { name: 'Turn on two-factor' })).toBeVisible()
    await expect(page.getByRole('form', { name: 'Change nameservers' })).toHaveCount(0)
    // Live lookups still show — this name is not in DNS.
    await expect(page.getByRole('list', { name: 'What public resolvers see' })).toContainText(
      'Not in DNS yet',
      {
        timeout: 20_000,
      },
    )
  })
})

test.describe('nameserver change', () => {
  let user: TestUser | undefined
  let name: string
  let secret: string

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('nameservers', { fullName: 'Ada Okafor' })
    name = (await createDemoDomain(user.id, { expiresInDays: 90 })).name
    secret = await enableTotp(user)
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('a typo is caught against live DNS; a real host is saved and logged (FR-D4, FR-N5)', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await signIn(page, user as TestUser, `/app/domains/${name}/nameservers`)
    await expect(page).toHaveURL(/\/verify/)
    const verify = page.getByRole('form', { name: 'Two-factor code' })
    await verify.getByLabel('6-digit code').fill(await freshTotpCode(secret))
    await verify.getByRole('button', { name: 'Continue' }).click()
    await expect(page).toHaveURL(
      new RegExp(`/app/domains/${name.replaceAll('.', '\\.')}/nameservers$`),
    )

    const form = page.getByRole('form', { name: 'Change nameservers' })
    await form.getByLabel('Nameservers').fill('ns1.vercel-dns.com\nns2.vercel-dnss.com')
    await form.getByRole('button', { name: 'Save nameservers' }).click()
    await expect(form.getByRole('alert')).toContainText(
      "ns2.vercel-dnss.com doesn't exist — check the spelling",
      {
        timeout: 20_000,
      },
    )

    // A preset fills the box from the verified list (FR-D1, FR-D2).
    await form.getByLabel('Where is your site hosted?').selectOption({ label: 'Vercel' })
    await expect(form.getByLabel('Nameservers')).toHaveValue(
      'ns1.vercel-dns.com\nns2.vercel-dns.com',
    )
    await form.getByRole('button', { name: 'Save nameservers' }).click()
    // A demo domain never reaches a registry, and the panel says so.
    await expect(form.getByRole('status')).toContainText(
      'Saved. This is a demo domain, so nothing is sent to a registry.',
      { timeout: 20_000 },
    )

    await page.reload()
    await expect(
      page.getByText(
        /Requested: ns1\.vercel-dns\.com, ns2\.vercel-dns\.com\. Nothing is sent to a registry\./,
      ),
    ).toBeVisible()
    await page
      .getByRole('navigation', { name: 'Domain' })
      .getByRole('link', { name: 'Activity' })
      .click()
    await expect(page.getByRole('list', { name: 'Activity' })).toContainText(
      'Nameserver change requested: ns1.vercel-dns.com, ns2.vercel-dns.com',
    )
  })
})
