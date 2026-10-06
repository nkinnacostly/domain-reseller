import AxeBuilder from '@axe-core/playwright'
import { expect as baseExpect, type Page, test } from '@playwright/test'
import { createTestUser, deleteTestUser, type TestUser } from './support/accounts'
import { createAccountFor, mockSesHas, verifyInMockSes } from './support/domains'

/**
 * MAIL-SPEC §5 against the real Supabase project and a mock SES and DNS
 * (support/mock-ses.mjs — no e2e test ever calls real SES or a real
 * resolver): add a domain → its records, each with copy buttons and a live
 * check → SES verifies it (mocked) → "Check now" → remove it. The account's
 * SES tenant is provisioned on the way, against the same mock. axe in both
 * themes and no sideways scroll from 320 to 1920 px, at each step.
 *
 * Signs in, so it runs on two projects only (Supabase limits sign-ins).
 */

const SIGN_IN_PROJECTS = ['chromium-desktop', 'mobile-ios']
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

async function checkPage(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await passesAxe(page)
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await fitsEveryWidth(page)
}

async function signIn(page: Page, user: TestUser) {
  await page.goto('/sign-in?next=%2Fdashboard%2Fdomains')
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/domains$/)
}

test.describe('domains (§5)', () => {
  let owner: TestUser
  const domain = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.example`

  test.beforeEach(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    owner = await createTestUser('domains', 'Dayo Domains')
    await createAccountFor(owner)
  })

  test.afterEach(async () => {
    if (owner) await deleteTestUser(owner)
  })

  test('add → records → verified (mocked) → remove', async ({ page }) => {
    test.setTimeout(240_000)
    await signIn(page, owner)
    await expect(page.getByRole('heading', { level: 1, name: 'Domains' })).toBeVisible()
    await expect(page.getByText('No domains yet')).toBeVisible()
    await checkPage(page)

    // A name that is ours is refused, in words, and nothing is added.
    const form = page.getByRole('form', { name: 'Add a domain' })
    await form.getByLabel('Domain').fill('mail.mydomainshub.com')
    await form.getByRole('button', { name: 'Add domain' }).click()
    await expect(form.getByText(/mydomainshub\.com and its subdomains are ours/)).toBeVisible()

    // Added: the tenant and the identity are set up at once, against the mock.
    await form.getByLabel('Domain').fill(domain.toUpperCase())
    await form.getByRole('button', { name: 'Add domain' }).click()
    await expect(page).toHaveURL(/\/dashboard\/domains\/[0-9a-f-]{36}$/)
    const addedAt = Date.now()
    const detail = page.url()
    await expect(page.getByRole('heading', { level: 1, name: domain })).toBeVisible()
    await expect(page.getByText('Waiting for DNS')).toBeVisible()
    await expect(page.getByText('To verify by')).toBeVisible()

    const records = page.getByRole('list', { name: 'DNS records' })
    await expect(records.getByRole('listitem')).toHaveCount(6)
    await expect(records.getByRole('heading', { name: /DKIM record 1 of 3/ })).toBeVisible()
    await expect(
      records.getByRole('button', { name: 'Copy the value of DKIM record 1 of 3' }),
    ).toBeVisible()
    await expect(records.getByText('feedback-smtp.eu-west-2.amazonses.com')).toBeVisible()
    // The live check: nothing published yet.
    await expect(records.getByText('Not found yet', { exact: true })).toHaveCount(6)
    if (test.info().project.name === 'chromium-desktop') {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await records.getByRole('button', { name: 'Copy the name of DKIM record 1 of 3' }).click()
      await expect(records.getByText('Copied')).toBeVisible()
    }
    await page.locator('summary').filter({ hasText: 'Cloudflare' }).click()
    await expect(page.getByText(/“DNS only” \(the grey cloud\)/)).toBeVisible()
    await checkPage(page)

    // SES sees the records; "Check now" reads it. SQL hands a domain out for a
    // check 15 seconds after its last (the add's own): a person adding DNS
    // records takes longer than that.
    await verifyInMockSes(domain)
    const sinceAdd = Date.now() - addedAt
    if (sinceAdd < 16_000) await page.waitForTimeout(16_000 - sinceAdd)
    await page.getByRole('button', { name: 'Check now' }).click()
    await expect(page.getByText('Checked: Amazon SES has verified this domain.')).toBeVisible()
    await expect(page.getByText('Verified', { exact: true }).first()).toBeVisible()
    await page.reload()
    // Three DKIM, the MX and SPF; the suggested DMARC is the owner's to add.
    await expect(records.getByText('Found', { exact: true })).toHaveCount(5)
    await expect(records.getByText('Not found yet', { exact: true })).toHaveCount(1)
    await checkPage(page)

    // The list says so too.
    await page.goto('/dashboard/domains')
    const row = page.locator(`[data-domain="${domain}"]`)
    await expect(row).toContainText('Verified')
    await checkPage(page)

    // Removed: off the tenant, deleted from SES, gone from the list.
    await page.goto(detail)
    await page.getByRole('button', { name: 'Remove domain' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog.getByRole('heading', { name: `Remove ${domain}?` })).toBeVisible()
    await passesAxe(page, '[role="alertdialog"]')
    await dialog.getByRole('button', { name: 'Remove domain' }).click()
    await expect(page).toHaveURL(/\/dashboard\/domains$/)
    await expect(page.getByText('No domains yet')).toBeVisible()
    expect(await mockSesHas(domain)).toBe(false)
  })
})
