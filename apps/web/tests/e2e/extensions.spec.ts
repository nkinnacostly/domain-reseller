import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * Per-extension landing pages (PRD FR-PUB1). Prices come from the live
 * catalogue, so the tests compare them with /pricing rather than pin numbers.
 */

const section = (page: Page, heading: string) =>
  page.locator('section', { has: page.getByRole('heading', { name: heading, exact: true }) })

/** The pricing table's row for an extension: first-year, renewal and transfer cells. */
async function pricingRow(page: Page, tld: string) {
  await page.goto('/pricing')
  const rows = await page.locator('tbody tr').evaluateAll((trs) =>
    trs.map((row) => ({
      tld: row.querySelector('th')?.childNodes[0]?.textContent?.trim() ?? '',
      // The first figure only: a renewal cell also says, to screen readers,
      // when it is higher than the first year.
      cells: [...row.querySelectorAll('td')]
        .slice(0, 3)
        .map((td) => td.textContent?.match(/₦[\d,]+/)?.[0] ?? ''),
    })),
  )
  return rows.find((row) => row.tld === `.${tld}`)?.cells ?? []
}

test.describe('extension page', () => {
  test('shows the first-year, renewal and transfer prices (N8)', async ({ page }) => {
    await page.goto('/domains/com')

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Register a .com domain')
    // The hero states both prices together.
    await expect(
      page
        .locator('main')
        .getByText(/₦[\d,]+ for the first year, then ₦[\d,]+ a year/)
        .first(),
    ).toBeVisible()

    const prices = section(page, 'What a .com domain costs')
    for (const label of ['First year', 'Renewal', 'Transfer in']) {
      await expect(prices.getByText(label, { exact: true })).toBeVisible()
    }
    await expect(prices.locator('dd').filter({ hasText: /^₦[\d,]+$/ })).toHaveCount(3)
  })

  test('quotes the same prices as the pricing table', async ({ page }) => {
    const [register, renew, transfer] = await pricingRow(page, 'com')
    expect(register, '.com missing from /pricing').toMatch(/^₦[\d,]+$/)

    await page.goto('/domains/com')
    const values = await section(page, 'What a .com domain costs')
      .locator('dd')
      .filter({ hasText: /^₦[\d,]+$/ })
      .allTextContents()
    expect(values).toEqual([register, renew, transfer])
  })

  test('describes a generic extension, ICANN fee included', async ({ page }) => {
    await page.goto('/domains/com')
    const about = section(page, 'About .com')
    await expect(about).toContainText('generic extension (gTLD)')
    await expect(about).toContainText('Registration period')
    await expect(about).toContainText(/Included: ICANN charges/)
  })

  test('says a country-code extension carries no ICANN fee', async ({ page }) => {
    await page.goto('/domains/co')
    const about = section(page, 'About .co')
    await expect(about).toContainText('country-code extension (ccTLD) for Colombia')
    await expect(about).toContainText('No ICANN fee')
  })

  test('its search box searches that extension', async ({ page }) => {
    await page.goto('/domains/com')
    const form = page.getByRole('form', { name: '.com domain search', exact: true })
    await page.locator('form[data-enhanced="true"]').first().waitFor()
    await form.getByLabel('Find your .com domain').fill('getpaid')
    await form.getByRole('button', { name: 'Search' }).click()

    await expect(page).toHaveURL(/\/search\?q=getpaid\.com$/)
  })

  test('answers the common questions from its own data', async ({ page }) => {
    await page.goto('/domains/com')
    await page.getByRole('button', { name: 'How much is a .com domain?' }).click()
    await expect(section(page, '.com questions')).toContainText(/₦[\d,]+ a year to renew/)
  })

  test('an extension we do not sell says so, rather than a price', async ({ page }) => {
    // The .ng family is paused (tlds.is_paused) until a fair-priced source is found.
    for (const [path, title] of [
      ['/domains/ng', "We don't sell .ng"],
      ['/domains/zzqqnotreal', "We don't sell .zzqqnotreal"],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 }), path).toHaveText(title)
      await expect(page.locator('main'), path).not.toContainText('₦')
      await expect(page.getByRole('link', { name: 'See every extension we sell' })).toBeVisible()
    }
  })

  test('the address is case- and dot-insensitive', async ({ page }) => {
    for (const path of ['/domains/COM', '/domains/.com']) {
      await page.goto(path)
      await expect(page, path).toHaveURL(/\/domains\/com$/)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Register a .com domain')
    }
  })

  test('has no accessibility violations', async ({ page }) => {
    await page.goto('/domains/com')
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('never scrolls horizontally', async ({ page }) => {
    await page.goto('/domains/com')
    for (const width of [320, 375, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(100)
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      expect(overflows, `horizontal overflow at ${width}px`).toBe(false)
    }
  })

  test('shares the page gutter with every other section', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.goto('/domains/com')

    const x = async (locator: ReturnType<Page['locator']>) =>
      Math.round((await locator.boundingBox())?.x ?? -1)
    const logo = await x(page.getByRole('banner').getByRole('link').first())
    for (const heading of ['What a .com domain costs', '.com questions']) {
      expect(await x(page.getByRole('heading', { name: heading, exact: true })), heading).toBe(logo)
    }
    expect(await x(page.getByRole('heading', { level: 1 }))).toBe(logo)
  })
})
