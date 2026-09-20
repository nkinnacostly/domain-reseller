import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.describe('pricing page', () => {
  test('leads with the Nigerian extensions at a flat price', async ({ page }) => {
    await page.goto('/pricing')

    const featured = page.getByRole('heading', { name: 'The Nigerian extensions' })
    await expect(featured).toBeVisible()

    // All four, and all advertised as flat.
    for (const tld of ['.ng', '.com.ng', '.net.ng', '.org.ng']) {
      await expect(page.getByRole('listitem').filter({ hasText: tld }).first()).toBeVisible()
    }
    expect(await page.getByText('Same price every year').count()).toBe(4)
  })

  /** PRD N8 — a price is never shown without its renewal price. */
  test('every table row shows a renewal price beside the first-year price', async ({ page }) => {
    await page.goto('/pricing')

    const headers = page.locator('table thead th')
    await expect(headers.nth(1)).toHaveText('First year')
    await expect(headers.nth(2)).toHaveText('Renewal')

    const firstRow = page.locator('tbody tr').first()
    await expect(firstRow.locator('td').nth(0)).toContainText('₦')
    await expect(firstRow.locator('td').nth(1)).toContainText('₦')
  })

  test('the long tail is not led by restricted .tr extensions', async ({ page }) => {
    await page.goto('/pricing')
    const first12 = await page
      .locator('tbody th')
      .evaluateAll((els) =>
        els.slice(0, 12).map((el) => el.textContent?.trim().split('\n')[0] ?? ''),
      )
    expect(first12.filter((t) => t.endsWith('.tr')).length).toBe(0)
  })

  test('filtering narrows the table and reports the count', async ({ page }) => {
    await page.goto('/pricing')
    const field = page.getByLabel('Find an extension')

    await field.fill('africa')
    await expect(page.getByText(/of 701 extensions/)).toBeVisible()
    await expect(page.locator('tbody tr')).toHaveCount(1)
    await expect(page.locator('tbody th').first()).toContainText('.africa')
  })

  test('a leading dot in the filter is tolerated', async ({ page }) => {
    await page.goto('/pricing')
    await page.getByLabel('Find an extension').fill('.africa')
    await expect(page.locator('tbody th').first()).toContainText('.africa')
  })

  test('an unmatched filter explains itself', async ({ page }) => {
    await page.goto('/pricing')
    await page.getByLabel('Find an extension').fill('zzzznotatld')
    await expect(page.getByText(/no extension matches/i)).toBeVisible()
  })

  test('show more reveals further extensions', async ({ page }) => {
    await page.goto('/pricing')
    const before = await page.locator('tbody tr').count()

    await page.getByRole('button', { name: /show more extensions/i }).click()
    expect(await page.locator('tbody tr').count()).toBeGreaterThan(before)
  })

  /**
   * Wholesale cost and margin are commercially sensitive. They are computed on
   * the server and must never reach the browser.
   */
  test('never ships wholesale cost or margin to the client', async ({ page }) => {
    await page.goto('/pricing')
    const html = await page.content()
    expect(html).not.toMatch(/costKobo|marginKobo|supplierCost|wholesale/i)
  })

  test('explains the ICANN fee and marks which extensions carry it', async ({ page }) => {
    await page.goto('/pricing')
    await expect(page.getByText(/USD 0\.20 per year/)).toBeVisible()

    // Match the extension exactly — `hasText: '.com'` also matches `.com.ng`.
    const marks = await page.locator('tbody tr').evaluateAll((rows) =>
      rows.map((row) => ({
        tld: row.querySelector('th')?.childNodes[0]?.textContent?.trim() ?? '',
        hasIcannMark: (row.textContent ?? '').includes('ICANN fee'),
      })),
    )

    const find = (tld: string) => marks.find((m) => m.tld === tld)
    expect(find('.com')?.hasIcannMark, 'gTLD .com should carry the fee').toBe(true)
    expect(find('.ng')?.hasIcannMark, 'ccTLD .ng should not').toBe(false)
    expect(find('.com.ng')?.hasIcannMark, 'ccTLD .com.ng should not').toBe(false)
  })

  test('states the exchange rate customers are charged at', async ({ page }) => {
    await page.goto('/pricing')
    await expect(page.getByText(/converted at a fixed rate of/)).toBeVisible()
    await expect(page.getByText(/₦[\d,]+ to the dollar/)).toBeVisible()
    await expect(page.getByText(/VAT at 7\.5%/).first()).toBeVisible()
  })

  /**
   * The rate is a fixed constant. There is no rate feed and no daily job, so
   * the site must not claim either. It did once: "we convert at the mid-market
   * rate plus a 4% buffer, updated daily at 08:00 WAT" — while charging a rate
   * roughly 19% above mid-market and never updating it. Restore those claims
   * only alongside a real fx_rates table.
   */
  test('claims no rate mechanism it does not have', async ({ page }) => {
    await page.goto('/pricing')
    const text = await page.locator('main').innerText()

    expect(text, 'claims a daily update that does not happen').not.toMatch(/updated daily/i)
    expect(text, 'claims to track the mid-market rate').not.toMatch(/mid-market/i)
  })

  test('no accessibility violations', async ({ page }) => {
    await page.goto('/pricing')
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('the table scrolls on its own, so the page never scrolls sideways', async ({ page }) => {
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/pricing')
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      expect(overflows, `page overflows at ${width}px`).toBe(false)
    }
  })

  test('shares the page gutter with every other section', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.goto('/pricing')

    const logo = await page.getByRole('banner').getByRole('link').first().boundingBox()
    const h1 = await page.getByRole('heading', { level: 1 }).boundingBox()
    const allExt = await page.getByRole('heading', { name: 'All extensions' }).boundingBox()

    expect(Math.round(logo?.x ?? -1)).toBe(Math.round(h1?.x ?? -2))
    expect(Math.round(allExt?.x ?? -1)).toBe(Math.round(h1?.x ?? -2))
  })
})

test.describe('one price everywhere', () => {
  /**
   * Regression: the home page and /pricing each had their own pricing path,
   * and drifted — .com showed ₦22,900 on the home page and ₦20,500 on
   * /pricing. A storefront whose whole pitch is honest pricing cannot quote
   * two prices for the same domain.
   */
  test('the home page and the pricing page agree on every featured price', async ({ page }) => {
    await page.goto('/pricing')
    const fromTable = await page.locator('tbody tr').evaluateAll((rows) =>
      Object.fromEntries(
        rows.map((row) => [
          // The th holds the TLD as its first text node, then an
          // "+ ICANN fee" span — textContent would merge the two.
          row.querySelector('th')?.childNodes[0]?.textContent?.trim() ?? '',
          row.querySelector('td')?.textContent?.trim() ?? '',
        ]),
      ),
    )

    await page.goto('/')
    // Scope to the Popular extensions section — the sibling "Trending this
    // week" list also renders <li> elements.
    const cards = await page
      .locator('section', { has: page.getByRole('heading', { name: 'Popular extensions' }) })
      .locator('li')
      .evaluateAll((items) =>
        items.map((li) => ({
          tld: li.querySelector('p')?.textContent?.trim() ?? '',
          badge: li.querySelector('span[class*="rounded-full"]')?.textContent?.trim() ?? '',
        })),
      )

    // The hero card quotes a real .ng price and must agree too — it carried a
    // hardcoded ₦18,500 while .ng was ₦20,900.
    const heroPrice = await page
      .locator('div', { hasText: /^getpaid\.ng/ })
      .first()
      .evaluate((el) => (el.textContent?.match(/₦[\d,]+/) ?? [])[0] ?? '')
    expect(heroPrice, 'hero card shows no price').toBeTruthy()
    expect(heroPrice, 'hero price disagrees with the pricing table').toBe(fromTable['.ng'])

    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      const tablePrice = fromTable[card.tld]
      expect(tablePrice, `${card.tld} missing from the pricing table`).toBeTruthy()
      expect(card.badge, `${card.tld} priced differently on the home page`).toContain(
        tablePrice ?? '',
      )
    }
  })
})
