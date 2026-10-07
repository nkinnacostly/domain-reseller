import { createPublicKey, createVerify } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { expect as baseExpect, type Page, test } from '@playwright/test'
import { createTestUser, deleteTestUser, type TestUser } from './support/accounts'
import { dcKeyFiles } from './support/dc-keys'
import { createAccountFor, mockSesHas, putOnCloudflare, verifyInMockSes } from './support/domains'

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

  test('add to Cloudflare: one click (Domain Connect) and a pasted token (§5.3)', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    // A name of its own: the first test removes `domain`, and SES may still hold it.
    const name = `cf-${domain}`
    const token = `e2e-cf-${Date.now()}-token-not-a-secret-0123456789`
    await signIn(page, owner)
    const form = page.getByRole('form', { name: 'Add a domain' })
    await form.getByLabel('Domain').fill(name)
    await form.getByRole('button', { name: 'Add domain' }).click()
    await expect(page).toHaveURL(/\/dashboard\/domains\/[0-9a-f-]{36}$/)
    const detail = page.url()
    const records = page.getByRole('list', { name: 'DNS records' })
    await expect(records.getByRole('listitem')).toHaveCount(6)
    // Not on Cloudflare yet: no card, the guides as before.
    await expect(page.getByRole('heading', { name: 'Add them to Cloudflare for you' })).toHaveCount(
      0,
    )

    await putOnCloudflare(name, token)
    await page.reload()
    const card = page.locator('section', {
      has: page.getByRole('heading', { name: 'Add them to Cloudflare for you' }),
    })
    await expect(card.getByText(`${name}’s DNS is on Cloudflare.`)).toBeVisible()
    await checkPage(page)

    // One click: Cloudflare's own apply page (stubbed here: no e2e test
    // reaches Cloudflare), signed so Cloudflare can check it with our key.
    await page.route('https://dash.cloudflare.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Cloudflare (e2e stub)</title><h1>Cloudflare (e2e stub)</h1>',
      }),
    )
    await card.getByRole('button', { name: 'Add records in Cloudflare' }).click()
    await expect(page).toHaveURL(/^https:\/\/dash\.cloudflare\.com\/domainconnect\//)
    const apply = new URL(page.url())
    expect(apply.pathname).toBe(
      '/domainconnect/v2/domainTemplates/providers/mydomainshub.com/services/mail/apply',
    )
    expect(apply.searchParams.get('domain')).toBe(name)
    expect(apply.searchParams.get('region')).toBe('eu-west-2')
    expect(apply.searchParams.get('redirect_uri')).toBe(`${detail}?from=cloudflare`)
    expect(apply.searchParams.get('key')).toBe('_dck1')
    const query = apply.search.slice(1)
    const signed = query.replace(/&key=[^&]*&sig=[^&]*$/, '')
    const signature = decodeURIComponent(/&sig=([^&]*)$/.exec(query)?.[1] ?? '')
    const publicKey = createPublicKey({
      key: Buffer.from(dcKeyFiles(new URL(detail).port || 3301).publicBase64(), 'base64'),
      format: 'der',
      type: 'spki',
    })
    expect(createVerify('RSA-SHA256').update(signed).verify(publicKey, signature, 'base64')).toBe(
      true,
    )
    await page.goto(detail)
    for (const n of [1, 2, 3]) {
      await expect(
        records.getByText(`${apply.searchParams.get(`dkim${n}`)}._domainkey`, { exact: true }),
      ).toBeVisible()
    }

    // Back from Cloudflare, approved or not.
    await page.goto(`${detail}?from=cloudflare`)
    await expect(page.getByText('Back from Cloudflare')).toBeVisible()
    await page.goto(`${detail}?from=cloudflare&error=access_denied`)
    await expect(
      page.getByText('You cancelled in Cloudflare, so your DNS is as it was.'),
    ).toBeVisible()

    // The token way: a wrong token is refused in words, the right one adds all six.
    await card.getByRole('button', { name: 'Use a Cloudflare API token instead' }).click()
    const tokenForm = card.getByRole('form', { name: 'Add records to Cloudflare' })
    await expect(card.getByRole('link', { name: /Create a token in Cloudflare/ })).toHaveAttribute(
      'href',
      /^https:\/\/dash\.cloudflare\.com\/profile\/api-tokens\?/,
    )
    await tokenForm.getByLabel('Cloudflare API token').fill(`e2e-wrong-${token}`)
    await tokenForm.getByRole('button', { name: 'Add the records' }).click()
    await expect(tokenForm.getByText(/Cloudflare did not accept that token/)).toBeVisible()
    await tokenForm.getByLabel('Cloudflare API token').fill(token)
    await tokenForm.getByRole('button', { name: 'Add the records' }).click()
    const done = card.getByRole('list', { name: 'What was done in Cloudflare' })
    await expect(done.getByText('Added', { exact: true })).toHaveCount(6)
    await expect(card.getByText(`Done in ${name}: 6 records added or fixed.`)).toBeVisible()
    await expect(tokenForm.getByLabel('Cloudflare API token')).toHaveValue('')
    await checkPage(page)

    // Public DNS (the mock's) now has every record, the suggested DMARC too.
    await page.reload()
    await expect(records.getByText('Found', { exact: true })).toHaveCount(6)
  })
})
