import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import {
  allowTransfersFor,
  createTestUser,
  deleteTestUser,
  settleTransfer,
  TEST_DOMAIN_PREFIX,
} from './support/accounts.mjs'

/**
 * Transfers in (PRD E9, FR-T1 – FR-T3) end to end, against the mock gateway
 * and mock Flutterwave (N12). The worker is stood in for by settleTransfer(),
 * which moves the job through the same database functions.
 *
 * The domains are `.co`: its registry publishes no RDAP, so the live registry
 * lookup leaves the owner to confirm and the supplier's check — the mock's —
 * decides. The mock accepts codes starting GOOD- and refuses the rest.
 */

type TestUser = { id: string; email: string; password: string }

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function signIn(page: Page, user: TestUser, next: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(next)}$`), { timeout: 30_000 })
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

const overflows = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )

const uniqueDomain = () =>
  `${TEST_DOMAIN_PREFIX}xfer${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.co`

/** Fills in what the account does not already know about the owner. */
async function fillTransfer(page: Page, code: string) {
  const form = page.getByRole('form', { name: 'Transfer checkout', exact: true })
  await form.getByLabel('Transfer code', { exact: true }).fill(code)
  await form.getByLabel('Phone', { exact: true }).fill('0803 123 4567')
  await form.getByLabel('Street address').fill('12 Admiralty Way')
  await form.getByLabel('City').fill('Lagos')
  await form.getByLabel('State').fill('Lagos')
  await form.getByLabel('Postcode').fill('100001')
  return form
}

/** Pays on the mock Flutterwave page and returns the order id. */
async function payAndReturn(page: Page, form: ReturnType<Page['getByRole']>) {
  await form.getByRole('button', { name: /^Pay / }).click()
  await expect(page.getByRole('heading', { name: 'Mock Flutterwave' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByRole('link', { name: 'Pay (test)' }).click()
  await expect(page).toHaveURL(/\/app\/orders\/[0-9a-f-]+\?payment=paid$/)
  return new URL(page.url()).pathname.split('/').at(-1) as string
}

test.describe('transfers in', () => {
  // Whole journeys: a live registry lookup, a payment and several settles each.
  test.describe.configure({ timeout: 120_000 })
  let user: TestUser | undefined

  test.beforeAll(async () => {
    await allowTransfersFor('co')
  })
  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('xfer', { fullName: 'Ada Okafor' })
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('transfers a domain in: the code, the owner, payment, then each step until it lands', async ({
    page,
  }) => {
    const domain = uniqueDomain()

    // The check page leads to the start (FR-T1 → FR-T2).
    await page.goto(`/transfer?domain=${domain}`)
    await expect(page.getByRole('link', { name: 'Transfer it to us' })).toHaveAttribute(
      'href',
      `/app/transfers/new?domain=${domain}`,
      { timeout: 20_000 },
    )

    await signIn(page, user as TestUser, `/app/transfers/new?domain=${domain}`)
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { name: `Transfer ${domain}` })).toBeVisible()
    await expect(main).toContainText('Test mode.')
    // N8: the renewal price beside the transfer price.
    await expect(main.getByRole('complementary', { name: 'Check and pay' })).toContainText(
      /Transfer ₦[\d,]+, then renews at ₦[\d,]+\/yr/,
    )
    await expect(main.getByRole('list', { name: 'Transfer checklist' })).toBeVisible()
    await expect(main).toContainText('usually takes up to five days')
    await expect(main.getByLabel('Transfer code', { exact: true })).toHaveAttribute(
      'type',
      'password',
    )
    await expect(page.getByLabel('First name')).toHaveValue('Ada')
    expect((await axe(page)).violations).toEqual([])
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await overflows(page), `horizontal overflow at ${width}px`).toBe(false)
    }
    await page.setViewportSize({ width: 1280, height: 900 })

    const form = await fillTransfer(page, 'GOOD-e2e-code')
    const orderId = await payAndReturn(page, form)

    await expect(page.getByText('Paid — transfer queued')).toBeVisible()
    await expect(main.getByRole('heading', { name: 'Transfer', exact: true })).toBeVisible()
    await expect(main.getByText('About transfers')).toBeVisible()
    const line = main.locator('[data-line-status]')
    await expect(line).toHaveText('Queued')

    // The registry takes the request; the page refreshes itself while the order is open.
    await settleTransfer(orderId, 'submitted')
    await expect(line).toHaveText('Transferring', { timeout: 15_000 })
    await expect(page.getByText(/Transfers usually take up to five days/).first()).toBeVisible()
    expect((await axe(page)).violations).toEqual([])

    await page.goto(`/app/domains/${domain}`)
    await expect(main.getByTestId('domain-status-pill')).toHaveText('Transfer in progress')
    await expect(main).toContainText('Transfer in progress.')
    await expect(main).toContainText('When the transfer completes')

    // A second transfer of the same name waits for this one.
    await page.goto(`/app/transfers/new?domain=${domain}`)
    await expect(main).toContainText('already paid for and under way')
    await expect(main.getByRole('button', { name: /^Pay / })).toHaveCount(0)

    await page.goto(`/app/orders/${orderId}`)
    await settleTransfer(orderId, 'transferred')
    await expect(line).toHaveText('Transferred', { timeout: 15_000 })
    await expect(page.getByText('Your domain has transferred in.')).toBeVisible()

    await page.goto(`/app/domains/${domain}`)
    await expect(main.getByTestId('domain-status-pill')).toHaveText(/Active|Expires in/)
    await expect(main).toContainText('30 November 2027')
    await page.goto(`/app/domains/${domain}/activity`)
    await expect(main).toContainText('Transfer request sent to the registry')
    await expect(main).toContainText(
      'Transferred into the registrar’s test system — expires 30 November 2027',
    )

    await page.goto('/app/orders')
    await expect(page.getByRole('list', { name: 'Your orders' })).toContainText('transfer')
  })

  test('a code the registry refuses is caught before payment, and nothing is charged (N4)', async ({
    page,
  }) => {
    // Both themes are designed (S3): this one runs dark, the others light.
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'))
    const domain = uniqueDomain()
    await signIn(page, user as TestUser, `/app/transfers/new?domain=${domain}`)
    await expect(page.locator('html')).toHaveClass(/dark/)
    const form = await fillTransfer(page, 'WRONG-code')
    await form.getByRole('button', { name: /^Pay / }).click()

    await expect(form.getByText(/didn’t accept that transfer code/)).toBeVisible({
      timeout: 20_000,
    })
    await expect(form.getByLabel('Transfer code', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    await expect(page).toHaveURL(new RegExp(`/app/transfers/new\\?domain=${escapeRegExp(domain)}$`))
    expect((await axe(page)).violations).toEqual([])

    // A locked domain says what to do about it.
    await form.getByLabel('Transfer code', { exact: true }).fill('LOCKED-code')
    await form.getByRole('button', { name: /^Pay / }).click()
    await expect(form.getByText(/Turn off the transfer lock/)).toBeVisible({ timeout: 20_000 })

    await page.goto('/app/orders')
    await expect(page.getByText('No orders yet.')).toBeVisible()
  })

  test('a transfer the registry refuses says why, and shows its refund', async ({ page }) => {
    const domain = uniqueDomain()
    await signIn(page, user as TestUser, `/app/transfers/new?domain=${domain}`)
    const orderId = await payAndReturn(page, await fillTransfer(page, 'GOOD-e2e-code'))

    await settleTransfer(orderId, 'submitted')
    await settleTransfer(orderId, 'TRANSFER_REJECTED')

    const main = page.getByRole('main')
    await expect(main.locator('[data-line-status]')).toHaveText('Failed', { timeout: 15_000 })
    await expect(main).toContainText('The transfer was refused or cancelled before it completed.')
    await expect(page.getByRole('alert').filter({ hasText: 'could not transfer' })).toContainText(
      'No money moved.',
    )
    const refunds = main.getByRole('region', { name: 'Refunds' })
    await expect(refunds.getByText(`Transfer of ${domain}`)).toBeVisible()
    await expect(refunds).toContainText('Test refund — no money moves.')
    expect((await axe(page)).violations).toEqual([])

    await page.goto(`/app/domains/${domain}`)
    await expect(main.getByTestId('domain-status-pill')).toHaveText('Transfer rejected')
    await expect(main).toContainText('Transfer refused.')
  })
})
