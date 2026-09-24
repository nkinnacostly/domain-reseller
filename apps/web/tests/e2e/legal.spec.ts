import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * Legal and help pages (PRD FR-PUB4, CMP-1 – CMP-5, CMP-14). These are
 * compliance surfaces: the checks below are the obligations, not the prose.
 */

const PAGES = [
  { path: '/legal', heading: 'Legal' },
  { path: '/legal/registration-agreement', heading: 'Registration agreement' },
  { path: '/legal/registrant-rights', heading: 'Registrants’ benefits and responsibilities' },
  { path: '/legal/privacy', heading: 'Privacy notice' },
  { path: '/legal/refunds', heading: 'Refund policy' },
  { path: '/legal/udrp', heading: 'Domain name disputes (UDRP)' },
  { path: '/legal/transfer-disputes', heading: 'Transfer disputes' },
  { path: '/help', heading: 'Help centre' },
  { path: '/contact', heading: 'Contact us' },
  { path: '/abuse', heading: 'Report abuse' },
] as const

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

const overflows = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )

for (const { path, heading } of PAGES) {
  test(`${path} renders, is accessible and never scrolls sideways`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    expect((await axe(page)).violations).toEqual([])

    await page.setViewportSize({ width: 320, height: 900 })
    expect(await overflows(page), `horizontal overflow at 320px on ${path}`).toBe(false)
  })
}

test('the legal pages read well in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/legal/registration-agreement')
  const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze()
  expect(results.violations.filter((violation) => violation.id === 'color-contrast')).toEqual([])
})

test.describe('compliance statements', () => {
  test('the agreement names the sponsoring registrar and never claims accreditation (CMP-1, CMP-3)', async ({
    page,
  }) => {
    await page.goto('/legal/registration-agreement')
    const main = page.getByRole('main')
    await expect(main).toContainText('Atak Domain Bilgi Teknolojileri A.Ş.')
    await expect(main).toContainText('We are not ourselves accredited by ICANN.')
    await expect(page.locator('body')).not.toContainText(/we are (an )?ICANN[- ]accredited/i)
  })

  test('the agreement links the UDRP, the transfer policies and the registrants’ rights (CMP-2, CMP-5)', async ({
    page,
  }) => {
    await page.goto('/legal/registration-agreement')
    const main = page.getByRole('main')
    for (const name of [
      /Uniform Domain-Name Dispute-Resolution Policy/,
      /^Transfer Policy/,
      /Transfer Dispute Resolution Policy/,
      /Registrants’ Benefits and Responsibilities/,
    ]) {
      await expect(main.getByRole('link', { name }).first()).toBeVisible()
    }
  })

  test('official ICANN texts open in a new tab and say so', async ({ page }) => {
    await page.goto('/legal/udrp')
    const link = page
      .getByRole('main')
      .getByRole('link', { name: /Uniform Domain-Name Dispute-Resolution Policy/ })
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
    await expect(link).toContainText('(opens in a new tab)')
  })

  test('the abuse page publishes our contact and the registrar’s (CMP-4)', async ({ page }) => {
    await page.goto('/abuse')
    const main = page.getByRole('main')
    await expect(
      main.getByRole('link', { name: 'hello@mydomainshub.com' }).first(),
    ).toHaveAttribute('href', 'mailto:hello@mydomainshub.com')
    await expect(main.getByRole('link', { name: 'domain@apiname.com' })).toBeVisible()
  })

  test('the privacy notice names the controller and lists every cookie the site sets (CMP-14)', async ({
    page,
  }) => {
    await page.goto('/legal/privacy')
    const main = page.getByRole('main')
    await expect(main).toContainText('CLOOP UNIVERSE TECH')
    for (const cookie of ['sb-', 'dr_cart', 'dr_cart_count']) {
      await expect(main).toContainText(cookie)
    }
    await expect(
      main.getByRole('link', { name: /Nigeria Data Protection Commission/ }),
    ).toBeVisible()
  })

  test('the legal side menu marks the page you are on', async ({ page }) => {
    await page.goto('/legal/refunds')
    const nav = page.getByRole('navigation', { name: 'Legal documents' })
    await expect(nav.getByRole('link', { name: 'Refund policy' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(nav.getByRole('link', { name: 'Privacy notice' })).not.toHaveAttribute(
      'aria-current',
      /.*/,
    )
  })

  test('contacts, the transfer lock and the transfer code are self-serve, and say where (FR-DS1, FR-DS5)', async ({
    page,
  }) => {
    await page.goto('/legal/registration-agreement')
    const agreement = page.getByRole('main')
    await expect(agreement).toContainText('Change them on the domain’s Contacts page')
    await expect(agreement).toContainText('shows its transfer code straight away')
    await expect(agreement).not.toContainText('self-service editing is not available yet')

    await page.goto('/legal/transfer-disputes')
    await expect(page.getByRole('main')).toContainText('on its Security page in your account')
    // N14: the five-day promise still stands where the page cannot reach the registry.
    await expect(page.getByRole('main')).toContainText('we send the code within five days')

    await page.goto('/help')
    await page.getByRole('button', { name: 'How do I move a domain away?' }).click()
    await expect(
      page.getByText(/turn the transfer lock off, then get\s+the transfer code/),
    ).toBeVisible()
  })

  test('help states the daily limit and the two-factor rule as they work (SEC-11, FR-A2)', async ({
    page,
  }) => {
    await page.goto('/help')
    await page
      .getByRole('button', { name: 'Is there a limit on how many domains I can buy?' })
      .click()
    await expect(
      page.getByText(/registrations and transfers in count, over the last 24 hours/),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Should I turn on two-factor authentication?' }).click()
    await expect(
      page.getByText(/Once your account holds more than\s+10 domains it is required to add more/),
    ).toBeVisible()
  })

  test('help answers expand', async ({ page }) => {
    await page.goto('/help')
    const question = page.getByRole('button', { name: 'How do I renew?' })
    await question.click()
    await expect(page.getByText(/Open the domain in your account and choose Renew\./)).toBeVisible()
  })

  test('help and the refund policy describe transfers in as they work (N9b, PRD E9)', async ({
    page,
  }) => {
    await page.goto('/help')
    await page.getByRole('button', { name: 'Can I transfer a domain to you?' }).click()
    const answer = page.getByText(/start the transfer from the result/)
    await expect(answer).toBeVisible()
    await expect(answer).toContainText('transfers usually take up to five days')
    await expect(page.getByRole('main')).not.toContainText('Starting a transfer is not available')

    await page.goto('/legal/refunds')
    const main = page.getByRole('main')
    await expect(main).toContainText('The transfer could not be completed')
    await expect(main).toContainText('A transfer that has completed')
  })
})

test.describe('footer', () => {
  test('publishes a real abuse contact, not a placeholder (CMP-4)', async ({ page }) => {
    await page.goto('/')
    const footer = page.getByRole('contentinfo')
    await expect(footer).not.toContainText('example.com')
    await expect(footer.getByRole('link', { name: 'hello@mydomainshub.com' })).toHaveAttribute(
      'href',
      'mailto:hello@mydomainshub.com',
    )
    await expect(footer).toContainText('CLOOP UNIVERSE TECH')
  })

  test('every support and legal link leads to a real page', async ({ page }) => {
    await page.goto('/')
    const footer = page.getByRole('contentinfo')
    const hrefs = await footer
      .locator('a[href^="/legal"], a[href="/help"], a[href="/contact"], a[href="/abuse"]')
      .evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute('href') ?? ''))])
    expect(hrefs.length).toBeGreaterThanOrEqual(9)
    for (const href of hrefs) {
      // The raw HTML always carries Next's not-found fallback, so judge what renders.
      const response = await page.goto(href)
      expect(response?.status(), href).toBe(200)
      await expect(page.getByRole('heading', { level: 1 }), href).not.toHaveText('Page not found')
    }
  })
})
