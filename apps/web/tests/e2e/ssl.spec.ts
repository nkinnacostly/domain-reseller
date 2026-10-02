import { expect, type Page, test } from '@playwright/test'
import {
  createTestUser,
  deleteCartsHolding,
  deleteTestUser,
  hasSslSchema,
  issueSslCertificate,
  orderLines,
  settleSslOrder,
  settleSslSetup,
} from './support/accounts.mjs'
import {
  axe,
  fillRegistrant,
  overflows,
  payOnMockFlutterwave,
  type TestUser,
  uniqueName,
} from './support/checkout-flow'
import { mockCertificate, mockCsr } from './support/ssl.mjs'

/**
 * SSL certificates (FR-SSL-1 – FR-SSL-8), end to end against the mock gateway
 * and mock Flutterwave (N12): the storefront, then a PositiveSSL bought, set
 * up with a pasted CSR, approved and downloaded. The gateway's queue work is
 * done by hand with the SQL functions it calls (`settleSslOrder`,
 * `settleSslSetup`, `issueSslCertificate`), so nothing reaches a supplier.
 *
 * Buying needs migration 39 and a synced price (`sync:ssl -- --apply`);
 * until then the storefront says prices are unavailable and the journey skips.
 */

async function noOverflowAt320(page: Page) {
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 900 }
  await page.setViewportSize({ width: 320, height: 900 })
  expect(await overflows(page), 'horizontal overflow at 320px').toBe(false)
  await page.setViewportSize({ width, height })
}

type Node = { '@type'?: string; name?: string; offers?: { price?: string } }
const services = async (page: Page): Promise<Node[]> =>
  (await page.locator('script[type="application/ld+json"]').allTextContents())
    .flatMap((block) => {
      const data = JSON.parse(block)
      return (data['@graph'] ?? [data]) as Node[]
    })
    .filter((node) => node['@type'] === 'Service')

const kobo = (text: string) => Math.round(Number(text.replace(/[^\d.]/g, '')) * 100)

test.describe('the SSL page', () => {
  test('is reached from the header, accessible, and fits 320px', async ({ page }) => {
    await page.goto('/')
    const main = page.getByRole('banner').getByRole('navigation', { name: 'Main' })
    if (await main.isVisible()) {
      await main.getByRole('link', { name: 'SSL', exact: true }).click()
    } else {
      await page.getByRole('button', { name: 'Open menu' }).click()
      await page
        .getByRole('banner')
        .getByRole('navigation', { name: 'Mobile' })
        .getByRole('link', { name: 'SSL', exact: true })
        .click()
    }
    await expect(page).toHaveURL(/\/ssl$/)
    await expect(
      page.getByRole('heading', { level: 1, name: 'The padlock, for a site you host yourself' }),
    ).toBeVisible()
    // N9b: never "valid for a year" — certificates last at most 200 days now.
    await expect(page.getByRole('main')).not.toContainText(/valid for (a|one) year/i)
    await expect(page.getByRole('main')).toContainText('200 days')

    expect((await axe(page)).violations).toEqual([])
    await noOverflowAt320(page)
  })

  test('shows each certificate with its term and what buying again costs, as its markup does', async ({
    page,
  }) => {
    test.skip(!(await hasSslSchema()), 'no SSL prices yet: apply migrations 38–39, then sync:ssl')
    await page.goto('/ssl')

    const offers = page.getByRole('list', { name: 'SSL certificates' }).getByRole('listitem')
    await expect(offers.first()).toBeVisible()
    const markup = await services(page)
    for (const offer of await offers.all()) {
      const name = (await offer.getByRole('heading', { level: 3 }).textContent()) ?? ''
      // N8: the price, its term, and that it never renews by itself.
      await expect(offer).toContainText('1-year subscription')
      await expect(offer).toContainText(/It never renews by itself.+₦[\d,]+ at today’s price/)
      const price = (await offer.getByText(/^₦[\d,]+$/).textContent()) ?? ''
      const node = markup.find((service) => service.name === name)
      expect(node, `structured data for ${name}`).toBeTruthy()
      expect(kobo(node?.offers?.price ?? '')).toBe(kobo(price))
    }
  })
})

test.describe('buying a certificate', () => {
  let user: TestUser | undefined
  let site = ''

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    test.skip(!(await hasSslSchema()), 'no SSL prices yet: apply migrations 38–39, then sync:ssl')
    user = await createTestUser('ssl', { fullName: 'Ada Okafor' })
    site = `${uniqueName()}.com`
  })
  test.afterEach(async () => {
    if (site) await deleteCartsHolding([site])
    if (user) await deleteTestUser(user.id)
  })

  test('buys a PositiveSSL, sets it up with a pasted CSR, and downloads it once issued', async ({
    page,
  }) => {
    const me = user as TestUser
    await page.goto('/sign-in?next=%2Fssl')
    const signIn = page.getByRole('form', { name: 'Sign in', exact: true })
    await signIn.getByLabel('Email').fill(me.email)
    await signIn.getByLabel('Password', { exact: true }).fill(me.password)
    await signIn.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/\/ssl$/)

    // FR-SSL-6: into the cart from the storefront.
    const single = page
      .getByRole('list', { name: 'SSL certificates' })
      .getByRole('listitem')
      .filter({ hasText: 'One name' })
    await single.getByLabel('The name it is for').fill(site)
    await single.getByRole('button', { name: 'Add to cart' }).click()
    await expect(single).toContainText(`The certificate for ${site} is in your cart.`)

    await page.goto('/cart')
    const line = page.locator(`[data-certificate="${site}"]`)
    await expect(line.getByRole('heading', { name: site })).toBeVisible()
    await expect(line).toContainText('1-year subscription')
    await expect(line).toContainText('It never renews by itself')
    expect((await axe(page)).violations).toEqual([])
    await noOverflowAt320(page)

    // FR-SSL-6: paid like a domain, with no nameservers to choose.
    await page.getByRole('link', { name: 'Continue to checkout' }).click()
    await expect(page).toHaveURL(/\/app\/checkout$/)
    await expect(page.getByRole('list', { name: 'SSL certificates you are buying' })).toContainText(
      site,
    )
    await expect(page.getByRole('form', { name: 'Checkout' })).not.toContainText('Nameservers')
    await fillRegistrant(page)
    const orderId = await payOnMockFlutterwave(page, 'Pay (test)')

    const [ordered] = await orderLines(orderId)
    expect(ordered).toMatchObject({ domain: site, item_type: 'ssl' })

    // FR-SSL-3: the gateway buys it (by hand here); the line links to its page.
    const [certificateId] = await settleSslOrder(orderId, 'bought')
    await page.reload()
    await expect(page.getByRole('main')).toContainText('Ordered')
    await page.getByRole('main').getByRole('link', { name: site }).click()
    await expect(page).toHaveURL(new RegExp(`/app/ssl/${certificateId}$`))

    // FR-SSL-4: the set-up, with the customer's own CSR.
    const setup = page.getByRole('form', { name: 'Set up the certificate' })
    await expect(setup).toBeVisible()
    await setup.getByLabel('Paste the CSR').fill(mockCsr(site))
    await setup.getByRole('button', { name: 'Check it' }).click()
    await expect(setup).toContainText(`The CA reads this request as being for ${site}`)
    await setup
      .getByRole('radiogroup', { name: 'Approval address' })
      .getByRole('radio', { name: `admin@${site}` })
      .check()
    const contact = setup.getByRole('group', { name: /Contact for the certificate/ })
    await contact.getByLabel('Phone', { exact: true }).fill('0803 123 4567')
    await contact.getByLabel('Street address').fill('12 Admiralty Way')
    await contact.getByLabel('City').fill('Lagos')
    await contact.getByLabel('State').fill('Lagos')
    await contact.getByLabel('Postcode').fill('100001')
    expect((await axe(page)).violations).toEqual([])
    await setup.getByRole('button', { name: 'Send to the certificate authority' }).click()
    await expect(page.getByRole('main')).toContainText('Sending your set-up.')

    // The supplier takes it; the CA emails the approver.
    await settleSslSetup(certificateId)
    await page.reload()
    await expect(page.getByRole('main')).toContainText(
      'Approve the email from the certificate authority.',
    )
    await expect(page.getByRole('main')).toContainText(`admin@${site}`)
    expect((await axe(page)).violations).toEqual([])
    await noOverflowAt320(page)

    // FR-SSL-7: issued — the certificate, its chain, and both in one, to download.
    await issueSslCertificate(certificateId, mockCertificate(site), mockCertificate('chain'))
    await page.reload()
    await expect(page.getByRole('main')).toContainText('Issued')
    await expect(page.getByLabel('Certificate', { exact: true })).toHaveValue(
      `${mockCertificate(site)}\n`,
    )
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: `Download ${site}.crt` }).click(),
    ])
    expect(download.suggestedFilename()).toBe(`${site}.crt`)
    await expect(page.getByRole('button', { name: `Download ${site}-fullchain.pem` })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reissue this certificate' })).toBeVisible()
    expect((await axe(page)).violations).toEqual([])
    await noOverflowAt320(page)
  })
})
