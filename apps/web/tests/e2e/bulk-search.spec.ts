import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { deleteCartsHolding, TEST_DOMAIN_PREFIX } from './support/accounts.mjs'

/**
 * Bulk search (PRD FR-S5), international names (FR-S8) and the length rules
 * (FR-S9, unit-tested — the catalogue has no length data to exercise here)
 * against the mock gateway in tests/e2e/support — never the live supplier
 * (N12). Names map to fixed answers there.
 *
 * Bulk searches are limited per address, so each test gets its own made-up
 * one: runs on five devices, and other builders' runs, never share a count.
 */
const testAddress = () =>
  `198.18.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-real-ip': testAddress() })
})

const results = (page: Page) =>
  page.getByRole('list', { name: 'Results, one row per name' }).getByRole('listitem')
/** The row for one name — matched on the name itself, not a note that mentions it. */
const row = (page: Page, name: string) =>
  results(page).filter({ has: page.getByText(name, { exact: true }) })
const summary = (page: Page) => page.locator('section[aria-labelledby="bulk-summary"]')

async function bulkSearch(page: Page, names: string[]) {
  await page.goto('/search/bulk')
  await page.locator('form[data-enhanced="true"]').waitFor()
  const form = page.getByRole('form', { name: 'Bulk search' })
  await form.getByLabel('Names to check').fill(names.join('\n'))
  await form.getByRole('button', { name: 'Check names' }).click()
  await expect(summary(page)).toBeVisible()
}

test.describe('bulk search', () => {
  test('the search page links to it', async ({ page }) => {
    await page.goto('/search?q=getpaid')
    await page.getByRole('link', { name: 'Search many at once' }).click()
    await expect(page).toHaveURL(/\/search\/bulk$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Search many names at once')
    await expect(page.getByText('Paste a list to check it in one go')).toBeVisible()
  })

  test('every line gets its own answer, with both prices on every free name (N8)', async ({
    page,
  }) => {
    await bulkSearch(page, [
      'getpaid',
      'takenbrand.net',
      'hotel.africa',
      'not_a_name',
      'getpaid.edu',
    ])

    await expect(results(page)).toHaveCount(5)
    const free = row(page, 'getpaid.com')
    await expect(free).toContainText('Available')
    await expect(free).toContainText(/₦[\d,]+\s*then ₦[\d,]+\/yr/)
    await expect(free.getByRole('button', { name: 'Add getpaid.com to cart' })).toBeVisible()
    await expect(row(page, 'takenbrand.net')).toContainText('Taken')
    await expect(row(page, 'hotel.africa')).toContainText('Premium')
    await expect(row(page, 'hotel.africa')).not.toContainText('₦')
    await expect(row(page, 'not_a_name')).toContainText('Not a domain')
    await expect(row(page, 'getpaid.edu')).toContainText("We don't sell .edu")

    await expect(summary(page).getByRole('heading')).toHaveText('1 of 5 available')
    await expect(page).toHaveURL(/\/search\/bulk\?names=getpaid%0Atakenbrand\.net/)
  })

  test('names without an extension are checked on each one ticked', async ({ page }) => {
    await page.goto('/search/bulk')
    await page.locator('form[data-enhanced="true"]').waitFor()
    const form = page.getByRole('form', { name: 'Bulk search' })
    await expect(form.getByRole('checkbox', { name: '.com' })).toBeChecked()
    await form.getByLabel('Names to check').fill('getpaid')
    await form.getByRole('checkbox', { name: '.net' }).check()
    await form.getByRole('button', { name: 'Check names' }).click()

    await expect(row(page, 'getpaid.com')).toContainText('Available')
    await expect(row(page, 'getpaid.net')).toContainText('Available')
    await expect(page).toHaveURL(/tld=com&tld=net$/)
  })

  test('a list that is too long is refused before anything is asked', async ({ page }) => {
    await page.goto('/search/bulk')
    await page.locator('form[data-enhanced="true"]').waitFor()
    const form = page.getByRole('form', { name: 'Bulk search' })
    const names = Array.from({ length: 21 }, (_, index) => `name${index}`)
    await form.getByLabel('Names to check').fill(names.join('\n'))
    await form.getByRole('button', { name: 'Check names' }).click()

    await expect(form.getByRole('alert')).toContainText("That's 21 names")
    await expect(page).toHaveURL(/\/search\/bulk$/)
  })

  test('a registry outage offers a retry that keeps the list', async ({ page }) => {
    await bulkSearch(page, ['gatewaydown'])
    await expect(row(page, 'gatewaydown.com')).toContainText("Couldn't check")
    await expect(summary(page).getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/search/bulk?names=gatewaydown&tld=com',
    )
  })

  test('adds every free name in one press, and they are in the cart', async ({ page }) => {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const plain = `${TEST_DOMAIN_PREFIX}bulk${id}`
    try {
      await bulkSearch(page, [plain, `${plain}.net`, 'takenbrand'])

      await summary(page).getByRole('button', { name: 'Add all 2 available to cart' }).click()
      await expect(summary(page).getByRole('status')).toContainText('Added 2 names to your cart.')
      await summary(page).getByRole('link', { name: 'View cart' }).click()

      const lines = page.getByRole('list', { name: 'Domains in your cart' }).getByRole('listitem')
      await expect(lines.getByRole('heading')).toHaveText([`${plain}.com`, `${plain}.net`])
    } finally {
      await deleteCartsHolding([`${plain}.com`, `${plain}.net`])
    }
  })

  test('limits bulk searches per address', async ({ page, context, request }) => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'one device is enough to count')
    const address = testAddress()
    await context.setExtraHTTPHeaders({ 'x-real-ip': address })
    const search = async (name: string) => {
      const response = await request.get(`/search/bulk?names=${name}`, {
        headers: { 'x-real-ip': address },
      })
      expect(response.ok()).toBe(true)
      return (await response.text()).includes('a lot of bulk searches')
    }

    // A fresh address gets its twenty.
    for (let n = 0; n < 20; n += 1) expect(await search(`getpaid${n}`)).toBe(false)
    // The count runs in fixed windows, so if one closed meanwhile, the next fills within 20 more.
    let limited = false
    for (let n = 20; n < 41 && !limited; n += 1) limited = await search(`getpaid${n}`)
    expect(limited).toBe(true)

    await page.goto('/search/bulk?names=onemore')
    await expect(page.getByText("That's a lot of bulk searches")).toBeVisible()
  })
})

test.describe('international names (FR-S8)', () => {
  test('a Unicode name is searched in its ASCII form and shown as read', async ({ page }) => {
    await page.goto('/search')
    await page.locator('form[data-enhanced="true"]').waitFor()
    const form = page.getByRole('form', { name: 'Domain search', exact: true })
    await form.getByLabel('Find your domain').fill('Café.com')
    await form.getByRole('button', { name: /search/i }).click()

    await expect(page).toHaveURL(/\/search\?q=caf%C3%A9\.com$/)
    const exact = page.locator('article[aria-labelledby="exact-domain"]')
    await expect(exact.getByRole('heading')).toHaveText('café.com')
    await expect(exact).toContainText('xn--caf-dma.com')
    await expect(exact.getByRole('button', { name: 'Add café.com to cart' })).toBeVisible()
  })

  test('an extension that refuses international names says so', async ({ page }) => {
    await page.goto(`/search?q=${encodeURIComponent('café.app')}`)
    await expect(page.locator('article[aria-labelledby="exact-domain"]')).toContainText(
      'Not available for this extension',
    )
  })

  test('a name mixing lookalike alphabets is refused, with the reason', async ({ page }) => {
    // The second letter is Cyrillic а (U+0430).
    await page.goto(`/search?q=${encodeURIComponent('pаypal.com')}`)
    await expect(page.getByText('That name mixes alphabets')).toBeVisible()
    await expect(page.getByText(/different alphabets \(Latin and Cyrillic\)/)).toBeVisible()
  })

  test('a name that can pass for a Latin one is flagged in a bulk search', async ({ page }) => {
    await bulkSearch(page, ['аррӏе.com', 'café.com'])
    await expect(row(page, 'аррӏе.com')).toContainText('Can pass for “apple”')
    await expect(row(page, 'café.com')).toContainText('xn--caf-dma.com')
  })
})

test.describe('bulk search quality', () => {
  test('has no detectable accessibility violations', async ({ page }) => {
    await bulkSearch(page, ['getpaid', 'takenbrand.net', 'café.com', 'not_a_name'])
    const report = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(report.violations).toEqual([])
  })

  test('never scrolls horizontally, even with long names', async ({ page }) => {
    await page.goto(
      `/search/bulk?names=${encodeURIComponent(`${'a'.repeat(60)}\n${'ö'.repeat(30)}.com`)}`,
    )
    await expect(summary(page)).toBeVisible()

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
