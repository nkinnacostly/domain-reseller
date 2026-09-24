import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import {
  createDemoDomain,
  createSandboxDomain,
  createTestUser,
  deleteTestUser,
  settleRenewal,
} from './support/accounts.mjs'

/**
 * Renewals (PRD E8, FR-RN1, FR-RN5 – FR-RN7) end to end, against the mock
 * gateway and mock Flutterwave (N12). The worker is stood in for by
 * settleRenewal(), which moves the job through the same database functions.
 */

type TestUser = { id: string; email: string; password: string }

async function signIn(page: Page, user: TestUser, next: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${next.replaceAll('.', '\\.')}$`))
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

const longDate = (iso: string, years: number) => {
  const date = new Date(iso)
  date.setUTCFullYear(date.getUTCFullYear() + years)
  return new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'Africa/Lagos' }).format(
    date,
  )
}

/** Chooses the years, pays on the mock Flutterwave page, and returns the order id. */
async function renewAndPay(page: Page, years: number) {
  const main = page.getByRole('main')
  await main.getByLabel('Renew for').selectOption(String(years))
  await main.getByRole('button', { name: /^Pay / }).click()
  await expect(page.getByRole('heading', { name: 'Mock Flutterwave' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByRole('link', { name: 'Pay (test)' }).click()
  await expect(page).toHaveURL(/\/app\/orders\/[0-9a-f-]+\?payment=paid$/)
  return new URL(page.url()).pathname.split('/').at(-1) as string
}

test.describe('renewals', () => {
  let user: TestUser | undefined

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('renew', { fullName: 'Ada Okafor' })
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('renews a domain for the years chosen, and says so once the registry shows it', async ({
    page,
  }) => {
    const domain = await createSandboxDomain((user as TestUser).id)
    await signIn(page, user as TestUser, `/app/domains/${domain.name}`)
    const main = page.getByRole('main')
    await main.getByRole('link', { name: 'Renew now' }).click()

    await expect(page).toHaveURL(new RegExp(`/app/domains/${domain.name}/renew$`))
    await expect(
      page.getByRole('navigation', { name: 'Domain' }).getByRole('link', { name: 'Renew' }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(main.getByRole('heading', { name: `Renew ${domain.name}` })).toBeVisible()
    await expect(main).toContainText('Test mode.')
    await expect(main).toContainText(`New expiry: ${longDate(domain.expiresAt, 1)}`)

    // The price, VAT and total follow the years (FR-C5).
    const pay = main.getByRole('button', { name: /^Pay / })
    const oneYear = await pay.textContent()
    await main.getByLabel('Renew for').selectOption('2')
    await expect(main).toContainText(`New expiry: ${longDate(domain.expiresAt, 2)}`)
    await expect(main).toContainText('Renewal (2 ×')
    await expect(pay).not.toHaveText(oneYear ?? '')
    expect((await axe(page)).violations).toEqual([])

    const orderId = await renewAndPay(page, 2)
    await expect(page.getByText('Paid — renewal queued')).toBeVisible()
    await expect(main.getByRole('heading', { name: 'Renewal', exact: true })).toBeVisible()
    await expect(main.getByText('About renewals')).toBeVisible()
    const line = main.locator('[data-line-status]')
    await expect(line).toHaveText('Queued')

    // A second renewal waits for the first.
    await page.goto(`/app/domains/${domain.name}/renew`)
    await expect(main).toContainText('A renewal of this domain is already paid for and being made.')
    await expect(main.getByRole('button', { name: /^Pay / })).toHaveCount(0)

    await page.goto(`/app/orders/${orderId}`)
    await settleRenewal(orderId, 'renewed')
    // The page refreshes itself while the order is open.
    await expect(line).toHaveText('Renewed', { timeout: 15_000 })
    await expect(page.getByText('Your domain is renewed.')).toBeVisible()

    await page.goto(`/app/domains/${domain.name}`)
    await expect(main).toContainText(longDate(domain.expiresAt, 2))
    await page.goto(`/app/domains/${domain.name}/activity`)
    await expect(main).toContainText(
      `Renewed for 2 years in the registrar’s test system — now expires ${longDate(domain.expiresAt, 2)}`,
    )
    await expect(main).toContainText('Renewal for 2 years paid for in order')

    await page.goto('/app/orders')
    await expect(page.getByRole('list', { name: 'Your orders' })).toContainText('renewal')
  })

  test('a renewal the registry refuses says why, and a test order owes nothing', async ({
    page,
  }) => {
    const domain = await createSandboxDomain((user as TestUser).id)
    await signIn(page, user as TestUser, `/app/domains/${domain.name}/renew`)
    const orderId = await renewAndPay(page, 1)

    await settleRenewal(orderId, 'DOMAIN_NOT_FOUND')

    const main = page.getByRole('main')
    await expect(main.locator('[data-line-status]')).toHaveText('Failed', { timeout: 15_000 })
    await expect(main).toContainText('The registry does not list this domain in our account.')
    await expect(page.getByRole('alert').filter({ hasText: 'could not renew' })).toContainText(
      'No money moved.',
    )
    const refunds = main.getByRole('region', { name: 'Refunds' })
    await expect(refunds.getByText(`Renewal of ${domain.name}`)).toBeVisible()
    await expect(refunds).toContainText('Test refund — no money moves.')
    expect((await axe(page)).violations).toEqual([])

    // The expiry is untouched.
    await page.goto(`/app/domains/${domain.name}`)
    await expect(main).toContainText(longDate(domain.expiresAt, 0))
  })

  test('says why a demo domain cannot be renewed, and offers no payment', async ({ page }) => {
    const demo = await createDemoDomain((user as TestUser).id)
    await signIn(page, user as TestUser, `/app/domains/${demo.name}/renew`)
    const main = page.getByRole('main')
    await expect(main).toContainText('Demo domains can’t be renewed.')
    await expect(main.getByRole('button', { name: /^Pay / })).toHaveCount(0)
    await expect(main.getByRole('link', { name: 'Back to the overview' })).toHaveAttribute(
      'href',
      `/app/domains/${demo.name}`,
    )
    // The overview offers no Renew button for it either.
    await page.goto(`/app/domains/${demo.name}`)
    await expect(main.getByRole('link', { name: 'Renew now' })).toHaveCount(0)
  })
})
