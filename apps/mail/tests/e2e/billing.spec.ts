import AxeBuilder from '@axe-core/playwright'
import { expect as baseExpect, type Page, test } from '@playwright/test'
import { createTestUser, deleteTestUser, type TestUser } from './support/accounts'
import { createTestAccount, renewOnMock } from './support/billing'

/**
 * MAIL-SPEC §8 billing against the real Supabase project and a mock
 * Flutterwave (N12): subscribe to Starter, the plan active with a test
 * invoice, a cancellation scheduled for the period's end and withdrawn, then
 * a failed renewal from Flutterwave's webhook putting the account past due —
 * with axe in both themes and no sideways scroll from 320 to 1920 px.
 *
 * The test person is made confirmed through the admin API, so nothing sends
 * an email. Journeys that sign in run on two projects: Supabase limits
 * sign-ins per address.
 */

const SIGN_IN_PROJECTS = ['chromium-desktop', 'mobile-ios']

// Every step waits on the hosted project, whose answers can take seconds.
const expect = baseExpect.configure({ timeout: 30_000 })

test.use({ reducedMotion: 'reduce' })
const WIDTHS = [320, 375, 414, 768, 1024, 1440, 1920]

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

async function passesAxe(page: Page, only?: string) {
  const builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
  ])
  const results = await (only ? builder.include(only) : builder).analyze()
  expect(results.violations).toEqual([])
}

/** Both themes (S3), every width (S5), and axe in each. */
async function checkPage(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await passesAxe(page)
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await fitsEveryWidth(page)
}

async function signIn(page: Page, user: TestUser) {
  await page.goto('/sign-in?next=%2Fdashboard%2Fbilling')
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/billing$/)
}

const plan = (page: Page, code: string) => page.locator(`[data-plan="${code}"]`)
const currentPlan = (page: Page) => page.getByRole('region', { name: 'Your plan', exact: true })

test.describe('billing, on a mock Flutterwave', () => {
  test.describe.configure({ mode: 'serial' })
  let owner: TestUser

  test.beforeAll(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    owner = await createTestUser('billing', 'Bisi Billing')
    await createTestAccount(owner, `Billing e2e ${Date.now()}`)
  })

  test.afterAll(async () => {
    if (owner) await deleteTestUser(owner)
  })

  test.beforeEach(() => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
  })

  test('subscribing to Starter makes it active, with its invoice (§8)', async ({ page }) => {
    await signIn(page, owner)
    await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible()
    await expect(currentPlan(page)).toContainText('Free')
    // Prices and VAT from the database: ₦20,000 + 7.5% is ₦21,500.
    const starter = plan(page, 'starter')
    await expect(starter).toContainText('₦20,000 a month + 7.5% VAT')
    await expect(starter).toContainText('Then ₦21,500 a month')
    await expect(plan(page, 'scale')).toHaveCount(0)
    await checkPage(page)

    await starter.getByRole('button', { name: 'Pay ₦21,500 and start Starter' }).click()
    await expect(page.getByRole('heading', { name: 'Mock Flutterwave' })).toBeVisible()
    await expect(page.getByText(/Pay NGN 21500 for MDM-/)).toBeVisible()
    await page.getByRole('link', { name: 'Pay (test)' }).click()

    await expect(page).toHaveURL(/\/dashboard\/billing\?payment=paid$/)
    await expect(page.getByText('Payment received. Your new plan is on')).toBeVisible()
    await expect(currentPlan(page).locator('[data-current-plan]')).toHaveText('Starter')
    await expect(currentPlan(page)).toContainText('Active')
    await expect(currentPlan(page)).toContainText('Test payments')
    await expect(currentPlan(page)).toContainText('Card on file: Visa ending 4242')
    await expect(plan(page, 'starter')).toContainText('Your plan')

    const invoices = page.getByRole('region', { name: 'Invoices' })
    const row = invoices.locator('[data-invoice^="MDM-TEST-INV-"]')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('₦21,500')
    await checkPage(page)

    await row.getByRole('link').click()
    await expect(page.getByRole('heading', { name: 'Receipt', level: 1 })).toBeVisible()
    await expect(page.getByText('Test payment — not a tax invoice.')).toBeVisible()
    await expect(page.getByText('RC 9771867')).toBeVisible()
    await expect(page.getByText('TIN 2622401595060')).toBeVisible()
    await expect(page.locator('[data-invoice-total]')).toHaveText('₦21,500')
    await expect(page.getByText('VAT (7.5%)')).toBeVisible()
    await checkPage(page)
    await page.getByRole('link', { name: 'Back to Billing' }).click()
    await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible()
  })

  test('a cancellation waits for the period’s end, and can be withdrawn (§8)', async ({ page }) => {
    await signIn(page, owner)
    const free = plan(page, 'free')
    await expect(free).toContainText('stays until')
    await expect(free).toContainText('The rest of the month is not refunded')
    await free.getByRole('button', { name: /^Cancel and move to Free on / }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('its card charges stop now')
    await passesAxe(page, '[role="alertdialog"]')
    await dialog.getByRole('button', { name: /^Cancel and move to Free on / }).click()
    await expect(dialog).toBeHidden()

    await expect(currentPlan(page)).toContainText('Change scheduled')
    await expect(currentPlan(page)).toContainText('Card charges for it have stopped')
    await expect(currentPlan(page)).toContainText('moves to the Free plan')
    await checkPage(page)

    await currentPlan(page).getByRole('button', { name: 'Keep Starter' }).click()
    await expect(currentPlan(page)).toContainText('Active')
    await expect(currentPlan(page).getByRole('button', { name: 'Keep Starter' })).toHaveCount(0)
  })

  test('a failed renewal puts the account past due, with a way to pay (§8)', async ({ page }) => {
    // Flutterwave's renewal run, through the webhook Paidly forwards: 200 is settled.
    expect(await renewOnMock(owner.email, 'failed')).toBe(200)

    await signIn(page, owner)
    const banner = page.getByRole('region', { name: 'Account status' })
    await expect(banner).toContainText('Your renewal payment has not come through')
    await expect(banner).toContainText('Sending continues until')
    await expect(banner.getByRole('link', { name: 'Go to Billing' })).toBeVisible()
    await expect(currentPlan(page)).toContainText('Past due')
    await expect(currentPlan(page)).toContainText('has not come through')
    await expect(
      plan(page, 'starter').getByRole('button', { name: 'Pay ₦21,500 for Starter' }),
    ).toBeVisible()
    await checkPage(page)
  })
})
