import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import {
  createTestUser,
  deleteTestUser,
  settleRegistration,
  TEST_DOMAIN_PREFIX,
} from './support/accounts.mjs'

/**
 * Checkout (PRD E3, FR-C5 – FR-C9, §13.4 steps 1–6) end to end, against the
 * mock gateway and mock Flutterwave in tests/e2e/support (N12). Orders are
 * real rows in the database, removed with their test users.
 */

type TestUser = { id: string; email: string; password: string }
const uniqueName = () =>
  `${TEST_DOMAIN_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

async function signInWithDomainInCart(page: Page, user: TestUser, name: string) {
  await page.goto('/sign-in?next=%2Fcart')
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/cart$/)

  await page.goto(`/search?q=${name}`)
  await page.getByRole('button', { name: `Add ${name}.com to cart` }).click()
  await expect(page.getByRole('link', { name: /In your cart/ }).first()).toBeVisible({
    timeout: 20_000,
  })
  await page.goto('/cart')
  await page.getByRole('link', { name: 'Continue to checkout' }).click()
  await expect(page).toHaveURL(/\/app\/checkout$/)
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

async function fillRegistrant(page: Page) {
  const form = page.getByRole('form', { name: 'Checkout' })
  await form.getByLabel('Phone', { exact: true }).fill('0803 123 4567')
  await form.getByLabel('Street address').fill('12 Admiralty Way')
  await form.getByLabel('City').fill('Lagos')
  await form.getByLabel('State').fill('Lagos')
  await form.getByLabel('Postcode').fill('100001')
  return form
}

test.describe('checkout, signed out', () => {
  test('sends you to sign in and back', async ({ page }) => {
    await page.goto('/app/checkout')
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%2Fcheckout$/)
  })

  test('the payment webhook refuses a sender without the secret hash (SEC-7)', async ({
    request,
  }) => {
    const response = await request.post('/api/webhooks/flutterwave', {
      headers: { 'verif-hash': 'not-the-hash' },
      data: { event: 'charge.completed', data: { id: 1, tx_ref: 'ord_x' } },
    })
    expect(response.status()).toBe(401)
  })
})

test.describe('checkout', () => {
  let user: TestUser | undefined

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('checkout', { fullName: 'Ada Okafor' })
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('shows every name in large type, itemises VAT, and has no accessibility violations', async ({
    page,
  }) => {
    const name = uniqueName()
    await signInWithDomainInCart(page, user as TestUser, name)

    const review = page.getByRole('list', { name: 'Domains you are buying' })
    await expect(review).toContainText(`${name}.com`)
    await expect(review).toContainText(/then ₦[\d,]+\/yr/)
    await expect(page.getByRole('form', { name: 'Checkout' })).toContainText('VAT (7.5%)')
    await expect(page.getByText('Test mode.')).toBeVisible()
    // CMP-1 / CMP-2: the agreement and the registrant's rights at the point of purchase.
    const form = page.getByRole('form', { name: 'Checkout' })
    await expect(form.getByRole('link', { name: 'registration agreement' })).toHaveAttribute(
      'href',
      '/legal/registration-agreement',
    )
    await expect(
      form.getByRole('link', { name: /Registrants.? Benefits and Responsibilities/ }),
    ).toHaveAttribute('href', '/legal/registrant-rights')

    // Pre-filled from the account.
    await expect(page.getByLabel('First name')).toHaveValue('Ada')
    await expect(page.getByLabel('Last name')).toHaveValue('Okafor')

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('catches missing details and the unticked confirmation before any payment (FR-C6)', async ({
    page,
  }) => {
    await signInWithDomainInCart(page, user as TestUser, uniqueName())
    const form = page.getByRole('form', { name: 'Checkout' })
    await form.getByRole('button', { name: /^Pay / }).click()

    await expect(form.getByText('Enter a street address')).toBeVisible()
    await expect(form.getByText('Enter a city')).toBeVisible()
    await expect(form.getByText('Tick the box to confirm the spelling')).toBeVisible()
    await expect(page).toHaveURL(/\/app\/checkout$/)
  })

  async function payFor(page: Page, name: string) {
    await signInWithDomainInCart(page, user as TestUser, name)
    const form = await fillRegistrant(page)
    await form.getByRole('checkbox').check()
    await form.getByRole('button', { name: /^Pay / }).click()
    await expect(page.getByRole('heading', { name: 'Mock Flutterwave' })).toBeVisible({
      timeout: 30_000,
    })
    await page.getByRole('link', { name: 'Pay (test)' }).click()
    await expect(page).toHaveURL(/\/app\/orders\/[0-9a-f-]+\?payment=paid$/)
    return new URL(page.url()).pathname.split('/').at(-1) as string
  }

  test('the order follows its registration without a reload (§13.4 steps 7–8)', async ({
    page,
  }) => {
    const name = uniqueName()
    const orderId = await payFor(page, name)
    const line = page.getByRole('main').locator('[data-line-status]')
    await expect(line).toHaveText('Queued')

    await settleRegistration(orderId, 'registered')

    // The page refreshes itself while the order is open.
    await expect(line).toHaveText('Registered', { timeout: 15_000 })
    await expect(page.getByText('Every domain in this order is registered.')).toBeVisible()
    // The order's own link — the sidebar also lists the domain under "Renew soonest".
    await page
      .getByRole('main')
      .getByRole('link', { name: `${name}.com` })
      .click()

    await expect(page.getByRole('heading', { name: `${name}.com` })).toBeVisible()
    await expect(page.getByText('Sandbox registration.')).toBeVisible()
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible()
  })

  test('a line the registry refuses says why, and a test order owes nothing', async ({ page }) => {
    const name = uniqueName()
    const orderId = await payFor(page, name)

    await settleRegistration(orderId, 'DOMAIN_TAKEN')

    const main = page.getByRole('main')
    await expect(main.locator('[data-line-status]')).toHaveText('Failed', { timeout: 15_000 })
    await expect(main).toContainText('Someone else registered this name before we could.')
    await expect(page.getByRole('alert').filter({ hasText: 'could not register' })).toContainText(
      'No money moved.',
    )
    // FR-R3: the failed line's refund is queued at once, with no ticket. On a
    // test order it says so, and that no money moves.
    const refunds = main.getByRole('region', { name: 'Refunds' })
    await expect(refunds.getByText(`${name}.com`)).toBeVisible()
    await expect(refunds).toContainText('Being processed')
    await expect(refunds).toContainText('Test refund — no money moves.')
    expect((await axe(page)).violations).toEqual([])

    await page.goto(`/app/domains/${name}.com`)
    await expect(page.getByText('Registration failed.')).toBeVisible()
  })

  test('paying takes you to Flutterwave and back to a paid, queued order', async ({ page }) => {
    const name = uniqueName()
    await signInWithDomainInCart(page, user as TestUser, name)
    const form = await fillRegistrant(page)
    await form.getByRole('checkbox').check()
    await form.getByRole('button', { name: /^Pay / }).click()

    await expect(page.getByRole('heading', { name: 'Mock Flutterwave' })).toBeVisible({
      timeout: 30_000,
    })
    await page.getByRole('link', { name: 'Pay (test)' }).click()

    await expect(page).toHaveURL(/\/app\/orders\/[0-9a-f-]+\?payment=paid$/)
    await expect(page.getByText('Paid — registration queued')).toBeVisible()
    await expect(page.getByText('This was a test payment')).toBeVisible()
    await expect(page.getByRole('main')).toContainText(`${name}.com`)

    // Bought names leave the cart.
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible()

    // A second return with the same transaction changes nothing.
    await page.goBack()
    await page.goto('/app/orders')
    await expect(page.getByRole('list', { name: 'Your orders' }).getByRole('listitem')).toHaveCount(
      1,
    )
  })

  test('cancelling on Flutterwave charges nothing and keeps the cart', async ({ page }) => {
    const name = uniqueName()
    await signInWithDomainInCart(page, user as TestUser, name)
    const form = await fillRegistrant(page)
    await form.getByRole('checkbox').check()
    await form.getByRole('button', { name: /^Pay / }).click()

    await expect(page.getByRole('heading', { name: 'Mock Flutterwave' })).toBeVisible({
      timeout: 30_000,
    })
    await page.getByRole('link', { name: 'Cancel' }).click()

    await expect(page).toHaveURL(/\?payment=cancelled$/)
    await expect(page.getByText('Payment cancelled. Nothing was charged.')).toBeVisible()
    await page.goto('/cart')
    await expect(page.getByRole('list', { name: 'Domains in your cart' })).toContainText(
      `${name}.com`,
    )
  })

  test('a return address someone edited to claim success is not believed', async ({ page }) => {
    await signInWithDomainInCart(page, user as TestUser, uniqueName())
    const form = await fillRegistrant(page)
    await form.getByRole('checkbox').check()
    await form.getByRole('button', { name: /^Pay / }).click()
    await expect(page.getByRole('heading', { name: 'Mock Flutterwave' })).toBeVisible({
      timeout: 30_000,
    })

    // Take the real return address, but invent a transaction id.
    const payHref =
      (await page.getByRole('link', { name: 'Pay (test)' }).getAttribute('href')) ?? ''
    const forged = new URL(payHref)
    forged.searchParams.set('transaction_id', '123456789')
    await page.goto(forged.toString())

    await expect(page).not.toHaveURL(/payment=paid/)
    await expect(page.getByText('Paid — registration queued')).toHaveCount(0)
  })
})
