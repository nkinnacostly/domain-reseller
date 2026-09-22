import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { createTestUser, deleteTestUser, TEST_DOMAIN_PREFIX } from './support/accounts.mjs'

/**
 * The cart (PRD E3, FR-C1 – FR-C5). Availability comes from the mock gateway
 * (N12); carts live in the real database and are removed in global teardown.
 */

const uniqueName = () =>
  `${TEST_DOMAIN_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

async function addFromSearch(page: Page, name: string) {
  await page.goto(`/search?q=${name}`)
  await page.getByRole('button', { name: `Add ${name}.com to cart` }).click()
  await expect(page.getByRole('link', { name: /In your cart/ }).first()).toBeVisible({
    timeout: 20_000,
  })
}

const cartLines = (page: Page) =>
  page.getByRole('list', { name: 'Domains in your cart' }).getByRole('listitem')

async function pricesFromTable(page: Page) {
  await page.goto('/pricing')
  const row = page
    .locator('tbody tr')
    .filter({ has: page.locator('th', { hasText: /^\.com/ }) })
    .first()
  const [first, renew] = await row
    .locator('td')
    .evaluateAll((cells) =>
      cells.slice(0, 2).map((cell) => cell.textContent?.match(/₦[\d,]+/)?.[0] ?? ''),
    )
  const kobo = (naira = '') => Number(naira.replace(/[₦,]/g, '')) * 100
  return { first: kobo(first), renew: kobo(renew) }
}

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString('en-NG')}`

test.describe('cart', () => {
  test('an empty cart says so and points to search', async ({ page }) => {
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Search for a domain' })).toHaveAttribute(
      'href',
      '/search',
    )
  })

  test('adding from search fills the cart and the header badge', async ({ page }) => {
    const name = uniqueName()
    await addFromSearch(page, name)
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'Cart, 1 domain' }),
    ).toBeAttached()

    await page.goto('/cart')
    await expect(cartLines(page)).toHaveCount(1)
    const line = cartLines(page).first()
    await expect(line.getByRole('heading')).toHaveText(`${name}.com`)
    // N8 — the renewal price beside the price.
    await expect(line).toContainText(/then ₦[\d,]+\/yr/)
    await expect(line).toContainText('Price held until')
  })

  test('the cart survives a reload — it is kept on the server, not in the page', async ({
    page,
  }) => {
    const name = uniqueName()
    await addFromSearch(page, name)
    await page.goto('/cart')
    await page.reload()
    await expect(cartLines(page).getByRole('heading')).toHaveText(`${name}.com`)
  })

  test('a longer period costs the first year plus renewals (FR-C2)', async ({ page }) => {
    const { first, renew } = await pricesFromTable(page)
    const name = uniqueName()
    await addFromSearch(page, name)
    await page.goto('/cart')

    await cartLines(page).first().getByLabel('Registration period').selectOption('3')
    await expect(cartLines(page).first()).toContainText(naira(first + 2 * renew))
    await expect(cartLines(page).first()).toContainText('for 3 years')
  })

  test('the summary itemises VAT and totals it (FR-C5)', async ({ page }) => {
    const name = uniqueName()
    await addFromSearch(page, name)
    await page.goto('/cart')

    const summary = page.getByRole('complementary', { name: 'Order summary' })
    await expect(summary).toContainText('VAT (7.5%)')
    const [subtotal, vat, total] = await summary
      .locator('dd')
      .evaluateAll((cells) =>
        cells.map((cell) => Number((cell.textContent ?? '').replace(/[₦,]/g, ''))),
      )
    expect(vat).toBeCloseTo((subtotal ?? 0) * 0.075, 0)
    expect(total).toBe((subtotal ?? 0) + (vat ?? 0))
  })

  test('auto-renew defaults on, privacy defaults on, and changes stick (FR-C3)', async ({
    page,
  }) => {
    await addFromSearch(page, uniqueName())
    await page.goto('/cart')

    const renew = page.getByRole('switch', { name: 'Renew automatically' })
    const privacy = page.getByRole('switch', { name: 'Contact privacy' })
    await expect(renew).toHaveAttribute('aria-checked', 'true')
    await expect(privacy).toHaveAttribute('aria-checked', 'true')

    await renew.click()
    await expect(renew).toHaveAttribute('aria-checked', 'false')
    await page.reload()
    await expect(page.getByRole('switch', { name: 'Renew automatically' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  test('removing the last domain empties the cart and the badge', async ({ page }) => {
    const name = uniqueName()
    await addFromSearch(page, name)
    await page.goto('/cart')
    await page.getByRole('button', { name: `Remove ${name}.com` }).click()
    await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible()
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'Cart', exact: true }),
    ).toBeAttached()
  })

  test('is honest that checkout is not open yet', async ({ page }) => {
    await addFromSearch(page, uniqueName())
    await page.goto('/cart')
    await expect(page.getByText("Checkout isn't open yet.")).toBeVisible()
  })

  test('has no accessibility violations and never scrolls sideways', async ({ page }) => {
    await addFromSearch(page, uniqueName())
    await page.goto('/cart')
    await expect(cartLines(page)).toHaveCount(1)

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])

    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      expect(overflows, `overflow at ${width}px`).toBe(false)
    }
  })
})

test.describe('cart and sign-in', () => {
  let user: { id: string; email: string; password: string } | undefined

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('cart')
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('an anonymous cart moves to your account when you sign in (FR-C1)', async ({ page }) => {
    const name = uniqueName()
    await addFromSearch(page, name)

    await page.goto('/sign-in?next=%2Fcart')
    const form = page.getByRole('form', { name: 'Sign in', exact: true })
    await form.getByLabel('Email').fill(user?.email ?? '')
    await form.getByLabel('Password', { exact: true }).fill(user?.password ?? '')
    await form.getByRole('button', { name: 'Sign in', exact: true }).click()

    await expect(page).toHaveURL(/\/cart$/)
    // First render after sign-in — the merge is one transaction (migration 10).
    await expect(cartLines(page).getByRole('heading')).toHaveText(`${name}.com`)
    await expect(page.getByText('Your cart is saved to your account.')).toBeVisible()
  })
})
