import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * Search results (PRD E1) against the mock gateway in tests/e2e/support —
 * never the live supplier (N12). Names map to fixed answers there.
 */

const exact = (page: Page) => page.locator('article[aria-labelledby="exact-domain"]')
const grid = (page: Page) =>
  page.getByRole('list', { name: /on other extensions$/ }).getByRole('listitem')
const alternatives = (page: Page) =>
  page.locator('section[aria-labelledby="suggestions-heading"]').getByRole('listitem')

test.describe('search results', () => {
  test('an available name leads with its price and its renewal price (N8)', async ({ page }) => {
    await page.goto('/search?q=getpaid')

    await expect(exact(page).getByRole('heading')).toHaveText('getpaid.com')
    await expect(exact(page)).toContainText('Available')
    await expect(exact(page).locator('[data-price="first-year"]')).toHaveText(/^₦[\d,]+$/)
    await expect(exact(page).locator('[data-price="renewal"]')).toHaveText(/^₦[\d,]+\/yr$/)
    await expect(exact(page)).toContainText('includes the ICANN fee')
  })

  /** FR-S2 — the renewal price is never smaller than 80% of the first-year size. */
  test('the renewal price is never the small print', async ({ page }) => {
    await page.goto('/search?q=getpaid')
    const sizes = await exact(page).evaluate((card) => {
      const size = (selector: string) =>
        Number.parseFloat(getComputedStyle(card.querySelector(selector) as Element).fontSize)
      return { first: size('[data-price="first-year"]'), renewal: size('[data-price="renewal"]') }
    })
    expect(sizes.renewal / sizes.first).toBeGreaterThanOrEqual(0.8)
  })

  test('checks the same name on the other featured extensions', async ({ page }) => {
    await page.goto('/search?q=getpaid')
    await expect(grid(page)).toHaveCount(5)
    const domains = await grid(page).evaluateAll((items) =>
      items.map((li) => li.querySelector('span')?.textContent?.trim()),
    )
    expect(domains).toEqual([
      'getpaid.net',
      'getpaid.org',
      'getpaid.africa',
      'getpaid.co',
      'getpaid.app',
    ])
  })

  test('a taken name offers a transfer check and 12 free alternatives (FR-S4)', async ({
    page,
  }) => {
    await page.goto('/search?q=takenbrand')

    await expect(exact(page)).toContainText('Taken')
    await expect(
      exact(page).getByRole('link', { name: /check whether it can transfer/i }),
    ).toHaveAttribute('href', '/transfer?domain=takenbrand.com#check')

    await expect(alternatives(page)).toHaveCount(12)
    await expect(alternatives(page).first()).toContainText('gettakenbrand.com')
  })

  test('a premium name is flagged, not priced', async ({ page }) => {
    await page.goto('/search?q=hotel.africa')
    await expect(exact(page).getByRole('heading')).toHaveText('hotel.africa')
    await expect(exact(page)).toContainText('Premium')
    await expect(exact(page)).toContainText('own premium price')
    await expect(exact(page).locator('[data-price]')).toHaveCount(0)
  })

  test('a name the extension forbids says why', async ({ page }) => {
    await page.goto('/search?q=x')
    await expect(exact(page)).toContainText('Not available')
    await expect(exact(page)).toContainText('cannot be registered')
  })

  test('an extension that did not answer says so, and prices nothing', async ({ page }) => {
    await page.goto('/search?q=flakycheck')
    const app = grid(page).filter({ hasText: 'flakycheck.app' })
    await expect(app).toContainText("Couldn't check")
    await expect(app).not.toContainText('₦')
  })

  test('an extension we do not sell is named, and the rest are checked', async ({ page }) => {
    await page.goto('/search?q=getpaid.edu')
    await expect(page.getByRole('heading', { name: "We don't sell .edu" })).toBeVisible()
    await expect(exact(page)).toHaveCount(0)
    await expect(grid(page).first()).toContainText('getpaid.com')
  })

  test('says plainly when no alternative is free', async ({ page }) => {
    await page.goto('/search?q=allgone')
    await expect(page.getByText('None of our usual variations are free')).toBeVisible()
  })

  test('a registry outage offers a retry instead of an empty page', async ({ page }) => {
    await page.goto('/search?q=gatewaydown')
    const failure = page.getByText("Availability isn't showing right now").first()
    await expect(failure).toBeVisible()
    await expect(page.getByRole('link', { name: 'Try again' }).first()).toHaveAttribute(
      'href',
      '/search?q=gatewaydown',
    )
  })

  test('a rate limit asks for a few seconds, not a support ticket', async ({ page }) => {
    await page.goto('/search?q=busysearch')
    await expect(page.getByText(/A lot of people are searching right now/).first()).toBeVisible()
  })

  test('is honest that checkout is not open, and about what happens to searches', async ({
    page,
  }) => {
    await page.goto('/search?q=getpaid')
    await expect(page.getByText("Checkout isn't open yet.")).toBeVisible()
    // FR-S7
    await expect(page.getByText('We never sell or share what you search for.')).toBeVisible()
  })

  test('searching again from the results page shows the new results', async ({ page }) => {
    await page.goto('/search?q=getpaid')
    await expect(exact(page).getByRole('heading')).toHaveText('getpaid.com')

    const form = page.getByRole('form', { name: 'Domain search', exact: true })
    await page.locator('form[data-enhanced="true"]').waitFor()
    await form.getByLabel('Find your domain').fill('takenbrand')
    await form.getByRole('button', { name: /search/i }).click()

    await expect(page).toHaveURL(/\/search\?q=takenbrand$/)
    await expect(exact(page).getByRole('heading')).toHaveText('takenbrand.com')
    await expect(exact(page)).toContainText('Taken')
  })
})

test.describe('search page states', () => {
  test('with no query, it asks for one', async ({ page }) => {
    await page.goto('/search')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Search for a domain')
    await expect(page.getByText('Type a name above to get started')).toBeVisible()
  })

  test('input that is not a domain is explained, not searched', async ({ page }) => {
    await page.goto('/search?q=%21%21%21')
    await expect(page.getByText("That doesn't look like a domain")).toBeVisible()
    await expect(exact(page)).toHaveCount(0)
  })
})

test.describe('search page quality', () => {
  test('has no detectable accessibility violations', async ({ page }) => {
    await page.goto('/search?q=takenbrand')
    await expect(alternatives(page).first()).toBeVisible()
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('never scrolls horizontally, even with a long name', async ({ page }) => {
    await page.goto(`/search?q=${'a'.repeat(40)}verylongname`)
    await expect(alternatives(page).first()).toBeVisible()

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

test.describe('one price everywhere', () => {
  test('search prices match the pricing table', async ({ page }) => {
    await page.goto('/pricing')
    const fromTable = await page.locator('tbody tr').evaluateAll((rows) =>
      Object.fromEntries(
        rows.map((row) => [
          row.querySelector('th')?.childNodes[0]?.textContent?.trim() ?? '',
          {
            // The cells carry notes ("— higher than the first year"); compare amounts.
            first: row.querySelectorAll('td')[0]?.textContent?.match(/₦[\d,]+/)?.[0] ?? '',
            renew: row.querySelectorAll('td')[1]?.textContent?.match(/₦[\d,]+/)?.[0] ?? '',
          },
        ]),
      ),
    )

    const com = fromTable['.com']
    expect(com, '.com missing from /pricing').toBeDefined()

    await page.goto('/search?q=getpaid')
    await expect(exact(page).locator('[data-price="first-year"]')).toHaveText(com?.first ?? '')
    await expect(exact(page).locator('[data-price="renewal"]')).toHaveText(`${com?.renew}/yr`)
  })
})
