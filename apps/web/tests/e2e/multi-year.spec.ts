import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import {
  createTestUser,
  deleteTestUser,
  orderLines,
  TEST_DOMAIN_PREFIX,
} from './support/accounts.mjs'

/**
 * An extension its registry sells only in multi-year blocks — .ai: 2, 4, 6, 8
 * or 10 years (migration 37, FR-C2, N8, N9b) — from search to a paid order,
 * against the mock gateway and mock Flutterwave (N12). Every price is read
 * from the page: the catalogue is the hosted one.
 *
 * .ai reaches the catalogue only once migration 37 is applied and the
 * catalogue sync has written it (`sync:catalogue -- --apply`); until then
 * there is nothing to buy, and these tests say so and skip.
 */

type TestUser = { id: string; email: string; password: string }
const uniqueName = () =>
  `${TEST_DOMAIN_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const kobo = (text: string) => Number(text.replace(/[^\d]/g, '')) * 100

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

async function noOverflowAt320(page: Page) {
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 900 }
  await page.setViewportSize({ width: 320, height: 900 })
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  expect(overflows, 'horizontal overflow at 320px').toBe(false)
  await page.setViewportSize({ width, height })
}

const exact = (page: Page) => page.getByRole('article').filter({ hasText: 'Exact match' })
const cartLine = (page: Page) =>
  page.getByRole('list', { name: 'Domains in your cart' }).getByRole('listitem').first()

async function addToCart(page: Page, name: string) {
  await page.goto(`/search?q=${name}.ai`)
  await page.getByRole('button', { name: `Add ${name}.ai to cart` }).click()
  await expect(page.getByRole('link', { name: /In your cart/ }).first()).toBeVisible({
    timeout: 20_000,
  })
  await page.goto('/cart')
}

test.describe('an extension sold only in blocks (.ai)', () => {
  test.beforeEach(async ({ request }) => {
    const every = await (await request.get('/llms-full.txt')).text()
    test.skip(
      !every.includes('/domains/ai):'),
      '.ai is not in the catalogue yet: apply migration 37, then sync:catalogue -- --apply',
    )
  })

  test('search states the two-year minimum and the renewal every two years, never per year', async ({
    page,
  }) => {
    const name = uniqueName()
    await page.goto(`/search?q=${name}.ai`)

    const card = exact(page)
    await expect(card.getByRole('heading', { name: `${name}.ai` })).toBeVisible()
    await expect(card.locator('[data-price="first-year"]')).toHaveText(/^₦[\d,]+$/)
    await expect(card).toContainText('for 2 years — the shortest term .ai allows')
    await expect(card.locator('[data-price="renewal"]')).toHaveText(/^₦[\d,]+ every 2 years$/)
    await expect(card).toContainText('after the first 2 years')
    await expect(card).not.toContainText('/yr')
    await expect(card).not.toContainText('first year')

    expect((await axe(page)).violations).toEqual([])
    await noOverflowAt320(page)
  })

  test('the cart offers 2, 4, 6, 8 or 10 years only, each at the two-year price times its blocks', async ({
    page,
  }) => {
    const name = uniqueName()
    await addToCart(page, name)

    const line = cartLine(page)
    await expect(line.getByRole('heading')).toHaveText(`${name}.ai`)
    const period = line.getByLabel('Registration period')
    await expect(period).toHaveValue('2')
    const options = await period.locator('option').allTextContents()
    expect(options.map((option) => Number(option.split(' ')[0]))).toEqual([2, 4, 6, 8, 10])
    const two = kobo(options[0]?.split('—')[1] ?? '')
    options.forEach((option, index) => {
      expect(kobo(option.split('—')[1] ?? ''), option).toBe(two * (index + 1))
    })
    await expect(period).toHaveAccessibleDescription(
      'The .ai registry sells 2, 4, 6, 8 or 10 years at a time.',
    )
    await expect(line).toContainText(/for 2 years, then ₦[\d,]+ every 2 years/)
    await expect(line).not.toContainText('/yr')

    expect((await axe(page)).violations).toEqual([])
    await noOverflowAt320(page)

    await period.selectOption('4')
    await expect(line).toContainText('for 4 years')
    await expect(period).toHaveValue('4')
  })

  test.describe('checkout', () => {
    let user: TestUser | undefined

    test.beforeEach(async () => {
      test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
      user = await createTestUser('multi-year', { fullName: 'Ada Okafor' })
    })
    test.afterEach(async () => {
      if (user) await deleteTestUser(user.id)
    })

    test('charges two years, and records a two-year line renewing every two years', async ({
      page,
    }) => {
      const name = uniqueName()
      await page.goto('/sign-in?next=%2Fcart')
      const signIn = page.getByRole('form', { name: 'Sign in', exact: true })
      await signIn.getByLabel('Email').fill((user as TestUser).email)
      await signIn.getByLabel('Password', { exact: true }).fill((user as TestUser).password)
      await signIn.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page).toHaveURL(/\/cart$/)
      await addToCart(page, name)
      const [twoYears] = await cartLine(page)
        .getByLabel('Registration period')
        .locator('option')
        .allTextContents()
      const price = kobo(twoYears?.split('—')[1] ?? '')

      await page.getByRole('link', { name: 'Continue to checkout' }).click()
      await expect(page).toHaveURL(/\/app\/checkout$/)
      const review = page.getByRole('list', { name: 'Domains you are buying' })
      await expect(review).toContainText(`${name}.ai`)
      await expect(review).toContainText(/2 years · ₦[\d,]+, then ₦[\d,]+ every 2 years/)
      await expect(review).not.toContainText('/yr')
      const [, charged, renews] =
        (await review.textContent())?.match(/2 years · (₦[\d,]+), then (₦[\d,]+) every 2 years/) ??
        []
      expect(kobo(charged ?? '')).toBe(price)
      expect((await axe(page)).violations).toEqual([])

      const form = page.getByRole('form', { name: 'Checkout' })
      await form.getByLabel('Phone', { exact: true }).fill('0803 123 4567')
      await form.getByLabel('Street address').fill('12 Admiralty Way')
      await form.getByLabel('City').fill('Lagos')
      await form.getByLabel('State').fill('Lagos')
      await form.getByLabel('Postcode').fill('100001')
      await form.getByRole('checkbox').check()
      await form.getByRole('button', { name: /^Pay / }).click()
      await expect(page.getByRole('heading', { name: 'Mock Flutterwave' })).toBeVisible({
        timeout: 30_000,
      })
      await page.getByRole('link', { name: 'Pay (test)' }).click()
      await expect(page).toHaveURL(/\/app\/orders\/[0-9a-f-]+\?payment=paid$/)

      await expect(page.getByRole('main')).toContainText(
        /2 years · renews at ₦[\d,]+ every 2 years/,
      )
      const orderId = new URL(page.url()).pathname.split('/').at(-1) as string
      const [line] = await orderLines(orderId)
      expect(line).toMatchObject({
        domain: `${name}.ai`,
        tld: 'ai',
        item_type: 'register',
        period_years: 2,
        renewal_years: 2,
      })
      expect(Number(line?.price_kobo)).toBe(price)
      // One year's renewal price, renewed in blocks of two: the renewal the page showed.
      expect(Number(line?.renewal_kobo) * 2).toBe(kobo(renews ?? ''))
    })
  })
})
