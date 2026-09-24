import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * WHOIS lookup (PRD FR-PUB2). Lookups go to the mock registries in
 * support/mock-gateway.mjs (RDAP_BOOTSTRAP_URL), never live ones:
 * lockedbrand.com is registered and locked, registrydown.com's registry
 * fails, anything else is unregistered, and .co has no RDAP service.
 */

const result = (page: Page) => page.locator('#result')

async function lookUp(page: Page, domain: string) {
  const form = page.getByRole('form', { name: 'WHOIS lookup', exact: true })
  await page.locator('form[data-enhanced="true"]').waitFor()
  await form.getByLabel('Domain to look up').fill(domain)
  await form.getByRole('button', { name: /look up/i }).click()
}

/**
 * Lookups are limited per address (30 per 10 minutes). Each test is its own
 * visitor, so a full run on five devices never trips the limit meant for one
 * person. Only a local server believes this header; the platform sets it.
 */
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.describe('whois page', () => {
  test('explains what a lookup shows before anything is asked', async ({ page }) => {
    await page.goto('/whois')

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Look up any domain')
    for (const heading of [
      'What a lookup shows',
      'Where the answer comes from',
      'Why owner details are hidden',
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    }
    await expect(result(page)).toHaveCount(0)
  })

  test('has no accessibility violations with a record showing', async ({ page }) => {
    await page.goto('/whois?domain=lockedbrand.com')
    await expect(result(page)).toBeVisible()

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('never scrolls horizontally with a record showing', async ({ page }) => {
    await page.goto('/whois?domain=lockedbrand.com')
    await expect(result(page)).toBeVisible()

    for (const width of [320, 375, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(100)
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      expect(overflows, `horizontal overflow at ${width}px`).toBe(false)
    }
  })

  test('the result shares the page gutter', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.goto('/whois?domain=lockedbrand.com')

    const x = async (locator: ReturnType<Page['locator']>) =>
      Math.round((await locator.boundingBox())?.x ?? -1)
    const logo = await x(page.getByRole('banner').getByRole('link').first())
    expect(await x(page.getByRole('heading', { level: 1 }))).toBe(logo)
    expect(await x(result(page).getByRole('heading', { level: 2 }))).toBe(logo)
    expect(await x(page.getByRole('heading', { name: 'What a lookup shows' }))).toBe(logo)
  })
})

test.describe('whois lookup', () => {
  test('a registered domain shows its registrar, dates, statuses and nameservers', async ({
    page,
  }) => {
    await page.goto('/whois')
    await lookUp(page, 'https://www.LockedBrand.com/')

    await expect(page).toHaveURL(/\/whois\?domain=lockedbrand\.com#result$/)
    await expect(result(page).getByRole('heading', { level: 2 })).toHaveText(
      'lockedbrand.com is registered',
    )
    await expect(result(page)).toContainText('Example Registrar, Inc.')
    await expect(result(page)).toContainText('12 April 2010')
    await expect(result(page)).toContainText('12 April 2031')

    const statuses = result(page).getByRole('list', { name: 'Status codes' })
    await expect(statuses).toContainText('client transfer prohibited')
    await expect(statuses).toContainText('locked it against transfers')
    await expect(result(page).getByRole('list', { name: 'Nameservers' })).toContainText(
      'ns1.example-dns.net',
    )
    await expect(result(page)).toContainText(/public record at \d{2}:\d{2} on /)
  })

  test('never shows an owner’s personal details, even when the registry publishes them', async ({
    page,
  }) => {
    await page.goto('/whois?domain=lockedbrand.com')
    await expect(result(page)).toContainText('Owner')

    // The whole document, streamed payload included — not just what is visible.
    const html = await page.content()
    for (const detail of ['Adaeze', 'adaeze.placeholder@example.net', '+234-800-000-0000']) {
      expect(html, `leaked ${detail}`).not.toContain(detail)
    }
  })

  test('an unregistered name offers to register it', async ({ page }) => {
    await page.goto('/whois?domain=zzqq-free-name-5521.com')

    await expect(result(page).getByRole('heading', { level: 2 })).toHaveText(
      "zzqq-free-name-5521.com isn't registered",
    )
    await expect(
      result(page).getByRole('link', { name: 'Register zzqq-free-name-5521.com' }),
    ).toHaveAttribute('href', '/search?q=zzqq-free-name-5521.com')
  })

  test('an extension without RDAP says it cannot be looked up', async ({ page }) => {
    await page.goto('/whois?domain=getpaid.co')
    await expect(result(page).getByRole('heading', { level: 2 })).toHaveText(
      "We can't look up .co domains",
    )
  })

  test('a registry that fails is reported, with a way to try again', async ({ page }) => {
    await page.goto('/whois?domain=registrydown.com')
    await expect(result(page).getByRole('heading', { level: 2 })).toHaveText(
      "The registry didn't answer",
    )
    await expect(result(page).getByRole('link', { name: 'Try again' })).toBeVisible()
  })

  test('a bare name is caught before any lookup', async ({ page }) => {
    await page.goto('/whois')
    await lookUp(page, 'getpaid')

    await expect(page.getByRole('form', { name: 'WHOIS lookup', exact: true })).toContainText(
      'Include the extension',
    )
    await expect(page).toHaveURL(/\/whois$/)
  })
})
