import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'
import { TEST_DOMAIN_PREFIX } from './accounts.mjs'

/**
 * The checkout journey's steps, for specs that need a paid order: sign in
 * with a name in the cart, fill the registrant, and pay on the mock
 * Flutterwave page (N12). Orders are real rows, removed with their users.
 */

export type TestUser = { id: string; email: string; password: string }

export const uniqueName = () =>
  `${TEST_DOMAIN_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

export const overflows = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )

export async function signInWithDomainInCart(page: Page, user: TestUser, name: string) {
  await page.goto('/sign-in?next=%2Fcart')
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/cart$/)

  await page.goto(`/search?q=${name}`)
  await page.getByRole('button', { name: `Add ${name}.com to cart` }).click()
  await expect(page.getByRole('link', { name: /In your cart/ }).first()).toBeVisible({
    timeout: 20_000,
  })
  await page.goto('/cart')
  await page.getByRole('link', { name: 'Continue to checkout' }).click()
  await expect(page).toHaveURL(/\/app\/checkout$/)
}

export async function fillRegistrant(page: Page) {
  const form = page.getByRole('form', { name: 'Checkout' })
  await form.getByLabel('Phone', { exact: true }).fill('0803 123 4567')
  await form.getByLabel('Street address').fill('12 Admiralty Way')
  await form.getByLabel('City').fill('Lagos')
  await form.getByLabel('State').fill('Lagos')
  await form.getByLabel('Postcode').fill('100001')
  return form
}

/**
 * Confirms, pays, and chooses `outcome` on the mock Flutterwave page.
 * Returns the order's id from the page it lands on.
 */
export async function payOnMockFlutterwave(page: Page, outcome: 'Pay (test)' | 'Cancel') {
  const form = page.getByRole('form', { name: 'Checkout' })
  await form.getByRole('checkbox', { name: /checked the spelling/ }).check()
  await form.getByRole('button', { name: /^Pay / }).click()
  await expect(page.getByRole('heading', { name: 'Mock Flutterwave' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByRole('link', { name: outcome }).click()
  await expect(page).toHaveURL(
    outcome === 'Pay (test)'
      ? /\/app\/orders\/[0-9a-f-]+\?payment=paid$/
      : /\/app\/orders\/[0-9a-f-]+\?payment=cancelled$/,
  )
  return new URL(page.url()).pathname.split('/').at(-1) as string
}
