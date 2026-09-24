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
 * Nameservers at checkout from a host preset (FR-C10, FR-D2, FR-D3, N11),
 * against the mock gateway and mock Flutterwave (N12). The presets are the
 * verified rows seeded in migration 12; the worker is stood in for by
 * settleRegistration().
 */

test.describe('host presets at checkout', () => {
  let user: TestUser | undefined

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('presets', { fullName: 'Ada Okafor' })
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('a host picked at checkout is waiting on the domain, and a per-zone host is explained', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const name = uniqueName()
    await signInWithDomainInCart(page, user as TestUser, name)
    const form = await fillRegistrant(page)

    await form.getByText('Already know where this domain is going?').click()
    await expect(
      form.getByRole('radio', { name: 'Leave the registrar’s default for now' }),
    ).toBeChecked()
    await form.getByRole('radio', { name: 'Pick my host' }).check()
    const host = form.getByLabel('Your host', { exact: true })

    // FR-D3 — a per-zone host has nothing to set yet: said on the spot, and
    // stopped before anything is charged.
    await host.selectOption({ label: 'Cloudflare' })
    await expect(form).toContainText('Cloudflare gives each domain its own nameservers')
    await form.getByRole('checkbox', { name: /checked the spelling/ }).check()
    await form.getByRole('button', { name: /^Pay / }).click()
    await expect(host).toHaveAttribute('aria-invalid', 'true')
    await expect(host).toBeFocused()
    await expect(page).toHaveURL(/\/app\/checkout$/)
    expect((await axe(page)).violations).toEqual([])

    // A host with fixed nameservers: shown before paying, from our table.
    await host.selectOption({ label: 'Vercel' })
    const listed = form.getByRole('list', { name: 'Vercel nameservers' })
    await expect(listed.getByRole('listitem').first()).toBeVisible()
    const nameservers = await listed.getByRole('listitem').allTextContents()
    expect(nameservers.length).toBeGreaterThanOrEqual(2)
    await expect(form.getByRole('link', { name: 'Vercel’s instructions' })).toHaveAttribute(
      'href',
      /^https:\/\/vercel\.com\//,
    )
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await overflows(page), `horizontal overflow at ${width}px`).toBe(false)
    }

    const orderId = await payOnMockFlutterwave(page, 'Pay (test)')

    // Paid: the domain carries the host's nameservers, to apply after registering.
    await page.goto(`/app/domains/${name}.com/nameservers`)
    await expect(page.getByText('Waiting for registration.')).toBeVisible()
    await expect(page.getByRole('main')).toContainText(nameservers.join(', '))

    await settleRegistration(orderId, 'registered')

    await page.goto(`/app/domains/${name}.com`)
    const pointing = page.getByRole('region', { name: 'Where it points' })
    await expect(pointing).toContainText('A change is waiting to be applied.')
    await expect(pointing).toContainText(nameservers.join(', '))
  })
})
