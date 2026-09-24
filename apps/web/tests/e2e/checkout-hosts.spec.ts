import { expect, test } from '@playwright/test'
import { createTestUser, deleteTestUser, settleRegistration } from './support/accounts.mjs'
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
 * A host per domain at checkout (FR-C10): the order's choice covers every
 * domain, and a mixed cart gives one its own. Typed nameservers are looked
 * up in public DNS before payment (FR-D4), as on the Nameservers tab. Against
 * the mock gateway and mock Flutterwave (N12); settleRegistration() stands in
 * for the worker. Presets are the verified rows seeded in migration 12.
 */

test.describe('a host per domain at checkout', () => {
  let user: TestUser | undefined

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('hosts', { fullName: 'Ada Okafor' })
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('a typo is caught before payment, and each domain gets its own host', async ({ page }) => {
    test.setTimeout(120_000)
    const [first, second] = [uniqueName(), uniqueName()]
    await signInWithDomainInCart(page, user as TestUser, first)
    await page.goto(`/search?q=${second}`)
    await page.getByRole('button', { name: `Add ${second}.com to cart` }).click()
    await expect(page.getByRole('link', { name: /In your cart/ }).first()).toBeVisible({
      timeout: 20_000,
    })
    await page.goto('/cart')
    await page.getByRole('link', { name: 'Continue to checkout' }).click()
    await expect(page).toHaveURL(/\/app\/checkout$/)
    const form = await fillRegistrant(page)

    // The order's choice: typed, with a typo in the second host.
    await form.getByText('Already know where this domain is going?').click()
    await form.getByRole('radio', { name: 'Enter nameservers' }).check()
    const box = form.getByLabel('Nameservers from your host', { exact: true })
    await box.fill('ns1.vercel-dns.com\nns2.vercel-dnss.com')

    // The second domain gets its own host.
    await form.getByText('Use a different host for a domain').click()
    await form.getByLabel(`${second}.com`, { exact: true }).selectOption({ label: 'Pick my host' })
    await form
      .getByLabel(`Host for ${second}.com`, { exact: true })
      .selectOption({ label: 'Hostinger' })
    const hostinger = await form
      .getByRole('list', { name: 'Hostinger nameservers' })
      .getByRole('listitem')
      .allTextContents()
    expect(hostinger.length).toBeGreaterThanOrEqual(2)
    expect((await axe(page)).violations).toEqual([])
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await overflows(page), `horizontal overflow at ${width}px`).toBe(false)
    }

    // FR-D4 — the typo stops the order, said beside the box, before any charge.
    await form.getByRole('checkbox', { name: /checked the spelling/ }).check()
    await form.getByRole('button', { name: /^Pay / }).click()
    await expect(box).toHaveAttribute('aria-invalid', 'true', { timeout: 20_000 })
    await expect(form).toContainText("ns2.vercel-dnss.com doesn't exist — check the spelling.")
    await expect(box).toBeFocused()
    await expect(page).toHaveURL(/\/app\/checkout$/)
    expect((await axe(page)).violations).toEqual([])

    await box.fill('ns1.vercel-dns.com\nns2.vercel-dns.com')
    const orderId = await payOnMockFlutterwave(page, 'Pay (test)')

    // The order says which domain has its own nameservers.
    const main = page.getByRole('main')
    await expect(main).toContainText(`Nameservers: ${hostinger.join(', ')}`)
    await expect(main).toContainText('Nameservers for the other domains')
    await expect(main).toContainText('ns1.vercel-dns.com, ns2.vercel-dns.com')
    expect((await axe(page)).violations).toEqual([])

    await settleRegistration(orderId, 'registered')

    // Registered: each domain is waiting on its own set, applied after registration (FR-R5).
    for (const [name, nameservers] of [
      [first, 'ns1.vercel-dns.com, ns2.vercel-dns.com'],
      [second, hostinger.join(', ')],
    ] as const) {
      await page.goto(`/app/domains/${name}.com`)
      const pointing = page.getByRole('region', { name: 'Where it points' })
      await expect(pointing).toContainText('A change is waiting to be applied.')
      await expect(pointing).toContainText(nameservers)
    }
  })
})
