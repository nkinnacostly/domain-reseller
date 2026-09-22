import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * Transfer-in landing and eligibility check (PRD FR-T1).
 *
 * The checks run against live registry RDAP servers — public, read-only and
 * free, so this is not the supplier or payment traffic N12 forbids. The
 * domains are chosen for answers that do not change: google.com is locked at
 * both registrar and registry, .co has no RDAP service, .edu is not an
 * extension we sell.
 */

const LOOKUP_TIMEOUT = 20_000

async function check(page: Page, domain: string) {
  const form = page.getByRole('form', { name: 'Transfer check', exact: true })
  await page.locator('form[data-enhanced="true"]').waitFor()
  await form.getByLabel('Domain to transfer').fill(domain)
  await form.getByRole('button', { name: /check domain/i }).click()
}

const result = (page: Page) => page.locator('#check')

test.describe('transfer page', () => {
  test('explains the process and shows transfer prices', async ({ page }) => {
    await page.goto('/transfer')

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bring your domain here')
    for (const heading of [
      'Four steps, most of them at your old registrar',
      'Before you start',
      'What a transfer costs',
      'Transfer questions',
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    }
    // No result until someone asks about a domain.
    await expect(result(page)).toHaveCount(0)
  })

  test('has no detectable accessibility violations', async ({ page }) => {
    await page.goto('/transfer?domain=google.com')
    await expect(result(page)).toBeVisible({ timeout: LOOKUP_TIMEOUT })

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('never scrolls horizontally, with a result showing', async ({ page }) => {
    await page.goto('/transfer?domain=zzqq-no-such-domain-83741.com')
    await expect(result(page)).toBeVisible({ timeout: LOOKUP_TIMEOUT })

    for (const width of [320, 375, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(100)
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      expect(overflows, `horizontal overflow at ${width}px`).toBe(false)
    }
  })
})

test.describe('transfer check', () => {
  test('a locked domain is blocked, with the reason and who to ask', async ({ page }) => {
    await page.goto('/transfer')
    await check(page, 'https://www.Google.com/')

    await expect(page).toHaveURL(/\/transfer\?domain=google\.com#check$/)
    await expect(result(page).getByRole('heading', { level: 2 })).toHaveText(
      "google.com can't be transferred yet",
      { timeout: LOOKUP_TIMEOUT },
    )

    const lock = result(page).getByRole('listitem').filter({ hasText: 'Transfer lock is off' })
    await expect(lock).toContainText('Blocked')
    await expect(lock).toContainText('MarkMonitor')
  })

  test('shows the transfer price with its renewal price (N8)', async ({ page }) => {
    await page.goto('/transfer?domain=google.com')
    const price = page.getByRole('complementary', { name: 'Transfer price for .com' })
    await expect(price).toContainText(/₦[\d,]+/, { timeout: LOOKUP_TIMEOUT })
    await expect(price).toContainText(/Then renews at ₦[\d,]+\/yr/)
  })

  test('an unregistered name offers registration instead', async ({ page }) => {
    await page.goto('/transfer?domain=zzqq-no-such-domain-83741.com')
    await expect(result(page).getByRole('heading', { level: 2 })).toHaveText(
      "zzqq-no-such-domain-83741.com isn't registered",
      { timeout: LOOKUP_TIMEOUT },
    )
    await expect(
      result(page).getByRole('link', { name: 'Search for zzqq-no-such-domain-83741.com' }),
    ).toHaveAttribute('href', '/search?q=zzqq-no-such-domain-83741.com')
  })

  test('an extension without RDAP is handed to the owner to confirm', async ({ page }) => {
    await page.goto('/transfer?domain=google.co')
    await expect(result(page).getByRole('heading', { level: 2 })).toHaveText(
      "We couldn't check everything for google.co",
      { timeout: LOOKUP_TIMEOUT },
    )
    await expect(result(page)).toContainText('The .co registry does not publish live records')
  })

  test('an extension we do not sell says so and points to the price list', async ({ page }) => {
    await page.goto('/transfer?domain=example.edu')
    await expect(result(page).getByRole('heading', { level: 2 })).toHaveText(
      "We don't take transfers for .edu yet",
    )
    await expect(result(page).getByRole('link', { name: 'See every extension' })).toHaveAttribute(
      'href',
      '/pricing',
    )
  })

  test('a bare name is caught before any lookup', async ({ page }) => {
    await page.goto('/transfer')
    await check(page, 'getpaid')

    await expect(page.getByRole('form', { name: 'Transfer check', exact: true })).toContainText(
      'Include the extension',
    )
    await expect(page).toHaveURL(/\/transfer$/)
  })

  test('pressing Enter checks, which is how most people submit', async ({ page }) => {
    await page.goto('/transfer')
    await page.locator('form[data-enhanced="true"]').waitFor()
    const field = page.getByLabel('Domain to transfer')
    await field.click()
    await field.pressSequentially('google.com')
    await field.press('Enter')
    await expect(page).toHaveURL(/\/transfer\?domain=google\.com#check$/)
  })
})

test.describe('one price everywhere', () => {
  test('transfer prices match the pricing table', async ({ page }) => {
    await page.goto('/pricing')
    const fromTable = await page
      .locator('tbody tr')
      .evaluateAll((rows) =>
        Object.fromEntries(
          rows.map((row) => [
            row.querySelector('th')?.childNodes[0]?.textContent?.trim() ?? '',
            row.querySelectorAll('td')[2]?.textContent?.trim() ?? '',
          ]),
        ),
      )

    await page.goto('/transfer')
    const cards = await page
      .getByRole('list', { name: 'Transfer prices' })
      .getByRole('listitem')
      .evaluateAll((items) =>
        items.map((li) => ({
          tld: li.querySelector('p')?.textContent?.trim() ?? '',
          price: li.querySelectorAll('p')[1]?.textContent?.trim() ?? '',
        })),
      )

    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      expect(card.price, `${card.tld} transfer price differs from /pricing`).toBe(
        fromTable[card.tld],
      )
    }
  })
})

test.describe('progressive enhancement', () => {
  test.use({ javaScriptEnabled: false })

  /**
   * Before hydration the native GET carries the domain to the check. The
   * result itself streams in behind Suspense, and React reveals streamed
   * content with an inline script — so with JavaScript fully off the URL is
   * right but the answer stays hidden. The URL is what this guarantees.
   */
  test('a submit before hydration still reaches the check', async ({ page }) => {
    await page.goto('/transfer')
    await page.getByLabel('Domain to transfer').fill('google.com')
    await page.getByRole('button', { name: /check domain/i }).click()

    await expect(page).toHaveURL(/\/transfer\?domain=google\.com$/)
  })
})
