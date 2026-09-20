import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.describe('homepage structure', () => {
  test('has one h1 and a heading for every section', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)

    // Scoped to main: the footer has its own headings.
    const main = page.locator('main')
    for (const heading of [
      'Popular extensions',
      'Trending this week',
      'Three steps, no tutorial',
      'Built for how domains are actually bought in Nigeria',
      'How we work out your price',
      'Questions people actually ask',
      'Find the name before someone else does',
    ]) {
      await expect(main.getByRole('heading', { name: heading })).toBeVisible()
    }
  })

  test('the hero is inside main, and the header stays a banner landmark', async ({ page }) => {
    await page.goto('/')

    // The h1 and the primary search belong to main, not to the header.
    await expect(page.locator('main h1')).toBeVisible()
    await expect(page.getByRole('form', { name: 'Domain search', exact: true })).toBeVisible()
    await expect(
      page.getByRole('form', { name: 'Domain search, end of page', exact: true }),
    ).toBeAttached()
    await expect(page.locator('main banner')).toHaveCount(0)
    await expect(page.getByRole('banner')).toBeVisible()
    await expect(page.getByRole('contentinfo')).toBeVisible()
  })

  test('the skip link target exists and sits before the hero heading', async ({ page }) => {
    await page.goto('/')
    const main = page.locator('#main')
    await expect(main).toBeAttached()
    await expect(main.getByRole('heading', { level: 1 })).toBeVisible()
  })
})

test.describe('footer compliance', () => {
  /**
   * These links are ICANN obligations that flow down to us as a reseller
   * (PRD CMP-2, CMP-4, CMP-5). Removing one is a compliance regression,
   * not a design change.
   */
  test('links the registrant rights specification', async ({ page }) => {
    await page.goto('/')
    await expect(
      page
        .getByRole('contentinfo')
        .getByRole('link', { name: /registrants' rights/i })
        .first(),
    ).toBeVisible()
  })

  test('publishes an abuse contact', async ({ page }) => {
    await page.goto('/')
    const footer = page.getByRole('contentinfo')
    await expect(footer.getByRole('link', { name: /report abuse/i })).toBeVisible()
    await expect(footer.locator('a[href^="mailto:"]')).toBeVisible()
  })

  test('links the UDRP and the transfer dispute policy', async ({ page }) => {
    await page.goto('/')
    const footer = page.getByRole('contentinfo')
    await expect(footer.getByRole('link', { name: /dispute-resolution policy/i })).toBeVisible()
    await expect(footer.getByRole('link', { name: /transfer dispute/i })).toBeVisible()
  })

  /** CMP-3 — we must never present ourselves as ICANN-accredited. */
  test('describes us as a reseller, never as accredited', async ({ page }) => {
    await page.goto('/')
    const text = (await page.getByRole('contentinfo').innerText()).toLowerCase()
    expect(text).toContain('authorised reseller')
    expect(text).not.toMatch(/we are icann[- ]accredited/)
    expect(text).not.toMatch(/icann[- ]accredited registrar\b(?!\.)/)
  })
})

test.describe('FAQ', () => {
  test('answers are collapsed until asked for, then expand', async ({ page }) => {
    await page.goto('/')

    const question = page.getByRole('button', { name: /do i need hosting/i })
    await expect(question).toHaveAttribute('aria-expanded', 'false')

    await question.click()
    await expect(question).toHaveAttribute('aria-expanded', 'true')
    await expect(
      page.getByText(/you can register a domain and point it somewhere later/i),
    ).toBeVisible()
  })
})

test.describe('full page accessibility', () => {
  test('no violations across the whole page', async ({ page }) => {
    await page.goto('/')
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('no violations in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze()
    expect(results.violations).toEqual([])
  })
})

test.describe('long-page responsiveness', () => {
  test('no horizontal overflow anywhere down the page', async ({ page }) => {
    await page.goto('/')

    for (const width of [320, 375, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(150)

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      expect(overflows, `horizontal overflow at ${width}px`).toBe(false)
    }
  })

  test('the shell fills a wide viewport instead of floating in a void', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await page.goto('/')

    const card = await page.locator('main').first().boundingBox()
    expect(card).not.toBeNull()
    // The card should use most of the viewport, not sit at a fixed narrow width.
    expect(card?.width ?? 0).toBeGreaterThan(1600)
  })
})
