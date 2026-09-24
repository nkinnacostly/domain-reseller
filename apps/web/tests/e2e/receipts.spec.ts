import { expect, test } from '@playwright/test'
import { createTestUser, deleteTestUser } from './support/accounts.mjs'
import {
  axe,
  fillRegistrant,
  overflows,
  payOnMockFlutterwave,
  signInWithDomainInCart,
  type TestUser,
  uniqueName,
} from './support/checkout-flow'

/**
 * Receipts (CMP-17, FR-C5, N8): a paid order's receipt, reached from the
 * order and the orders list, printable on its own. Paid through the mock
 * Flutterwave (N12), so every receipt here is a test one.
 */

test.describe('receipts, signed out', () => {
  test('sends you to sign in', async ({ page }) => {
    await page.goto('/app/orders/6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10/receipt')
    await expect(page).toHaveURL(/\/sign-in\?next=/)
  })
})

test.describe('receipts', () => {
  let user: TestUser | undefined

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('receipt', { fullName: 'Ada Okafor' })
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('an unpaid order has none; a paid one has a complete, printable receipt', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const name = uniqueName()
    await signInWithDomainInCart(page, user as TestUser, name)

    // Closed on Flutterwave: nothing paid, so no receipt.
    await fillRegistrant(page)
    const unpaidId = await payOnMockFlutterwave(page, 'Cancel')
    const main = page.getByRole('main')
    await expect(main.getByRole('link', { name: 'View receipt' })).toHaveCount(0)
    await page.goto(`/app/orders/${unpaidId}/receipt`)
    await expect(page.getByRole('heading', { name: 'No receipt for this order' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toHaveCount(0)

    // Paid: the order links to its receipt.
    await page.goto('/app/checkout')
    await fillRegistrant(page)
    const orderId = await payOnMockFlutterwave(page, 'Pay (test)')
    await main.getByRole('link', { name: 'View receipt' }).click()
    await expect(page).toHaveURL(new RegExp(`/app/orders/${orderId}/receipt$`))

    const receipt = page.getByRole('article', { name: 'Receipt' })
    // Test orders take numbers from their own series (migration 26).
    await expect(receipt.locator('[data-invoice-number]')).toHaveText(/^TEST-INV-\d{6}$/)
    const invoice = (await receipt.locator('[data-invoice-number]').textContent()) ?? ''
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Receipt ${invoice}`)
    await expect(receipt).toContainText('Test payment — not a tax invoice.')
    await expect(receipt.getByRole('region', { name: 'From' })).toContainText('CLOOP UNIVERSE TECH')
    const billed = receipt.getByRole('region', { name: 'Billed to' })
    await expect(billed).toContainText('Ada Okafor')
    await expect(billed).toContainText('12 Admiralty Way')
    const lines = receipt.getByRole('table', { name: 'What this order paid for' })
    await expect(lines).toContainText(`${name}.com`)
    // N8 — the renewal price beside the price.
    await expect(lines).toContainText(/Registration, 1 year · renews at ₦[\d,]+\/yr/)
    await expect(lines.getByRole('rowheader', { name: 'VAT (7.5%)' })).toBeVisible()
    await expect(lines.getByRole('rowheader', { name: 'Total', exact: true })).toBeVisible()
    const payment = receipt.getByRole('region', { name: 'Payment' })
    await expect(payment).toContainText('Card, through Flutterwave')
    await expect(payment).toContainText(/MDH-[0-9a-f-]{36}/)

    // The button opens the print dialog.
    await page.evaluate(() => {
      const counted = window as unknown as { printed: number }
      counted.printed = 0
      window.print = () => {
        counted.printed += 1
      }
    })
    await page.getByRole('button', { name: 'Print or save as PDF' }).click()
    expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1)

    expect((await axe(page)).violations).toEqual([])
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await overflows(page), `horizontal overflow at ${width}px`).toBe(false)
    }

    // On paper only the receipt shows, and in the light palette even from dark mode.
    await page.setViewportSize({ width: 768, height: 900 })
    const heading = receipt.getByRole('heading', { name: 'Receipt', exact: true })
    const colour = () => heading.evaluate((element) => getComputedStyle(element).color)
    const light = await colour()
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    expect(await colour()).not.toBe(light)
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible()
    await page.emulateMedia({ media: 'print' })
    await expect(receipt).toBeVisible()
    expect(await colour()).toBe(light)
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden()
    // A wide page shows the sidebar on screen; it never prints.
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.getByRole('complementary', { name: 'Panel' })).toBeHidden()
    await expect(receipt).toBeVisible()
    await page.emulateMedia({ media: 'screen' })
    await expect(page.getByRole('complementary', { name: 'Panel' })).toBeVisible()

    // The orders list names each receipt by its invoice number.
    await page.goto('/app/orders')
    const orders = page.getByRole('list', { name: 'Your orders' })
    await expect(orders.getByRole('listitem')).toHaveCount(2)
    await expect(orders.getByRole('link', { name: /^Receipt / })).toHaveCount(1)
    await orders.getByRole('link', { name: `Receipt ${invoice}` }).click()
    await expect(page).toHaveURL(new RegExp(`/app/orders/${orderId}/receipt$`))
  })
})
