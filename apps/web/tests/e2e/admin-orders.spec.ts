import AxeBuilder from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import {
  createAdminTestUser,
  createTestUser,
  deleteTestUser,
  hasAdminSchema,
  settleRegistration,
} from './support/accounts.mjs'
import { type AdminUser, expect, SIGN_IN_PROJECTS, signInAsAdmin, test } from './support/admin'
import {
  fillRegistrant,
  payOnMockFlutterwave,
  signInWithDomainInCart,
  type TestUser,
  uniqueName,
} from './support/checkout-flow'

/**
 * The orders pages (docs/ADMIN-SPEC.md §5.2, §9 B2), as a test-only
 * operator on the Test side. One order is bought through checkout and the
 * mock Flutterwave, then registered with settleRegistration — the queue
 * functions the gateway calls (N12). The pages are read only: nothing here
 * changes a record.
 */

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

async function overflowAt(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 })
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

const EMAIL_REFUSED =
  'Nothing was searched: orders are never looked up by email, because an email in a link stays in browser history and logs.'

test.describe.configure({ mode: 'serial' })

test.describe('the orders pages, as a test administrator', () => {
  let customer: TestUser | undefined
  let admin: AdminUser | undefined
  let order: { id: string; number: string; domain: string } | undefined
  let contexts: BrowserContext[] = []
  let page: Page

  test.beforeAll(async ({ browser }, info) => {
    test.skip(!SIGN_IN_PROJECTS.includes(info.project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migration 40 is not applied to this database')
    test.setTimeout(180_000)

    customer = await createTestUser('orders', { fullName: 'Order Person' })
    admin = (await createAdminTestUser('orders')) as AdminUser

    // A paid test order, bought as a customer would, on a desktop-sized page.
    const shop = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    contexts.push(shop)
    const buyer = await shop.newPage()
    const name = uniqueName()
    await signInWithDomainInCart(buyer, customer, name)
    await fillRegistrant(buyer)
    const id = await payOnMockFlutterwave(buyer, 'Pay (test)')
    const title = (await buyer.getByRole('heading', { level: 1 }).textContent()) ?? ''
    const number = /ND-\d+/.exec(title)?.[0]
    if (!number) throw new Error(`no order number in "${title}"`)
    await settleRegistration(id, 'registered')
    order = { id, number, domain: `${name}.com` }

    const desk = await browser.newContext()
    contexts.push(desk)
    page = await desk.newPage()
    await signInAsAdmin(page, admin, '/admin/orders')
  })

  test.afterAll(async () => {
    for (const context of contexts) await context.close()
    contexts = []
    // Each user goes with its test orders, one failure not stopping the other;
    // a statement timeout on a busy shared database gets one more try.
    for (const id of [customer?.id, admin?.user.id]) {
      if (id) await deleteTestUser(id).catch(() => deleteTestUser(id))
    }
    customer = undefined
    admin = undefined
  })

  test('the seeded order appears, newest first, with its buyer masked', async () => {
    if (!order || !customer) throw new Error('no order')
    await page.goto('/admin/orders')
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Funnel' })).toBeVisible()
    await expect(
      page
        .getByText(/^(counted since .+|not counted yet)$/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible()

    const link = page.getByRole('link', { name: order.number, exact: true })
    await expect(link).toBeVisible()

    // The sidebar marks the page (S13); on a phone it is a drawer.
    const nav = page.getByRole('navigation', { name: 'Admin' }).first()
    if (!(await nav.isVisible())) await page.getByRole('button', { name: 'Open menu' }).click()
    await expect(
      page
        .getByRole('navigation', { name: 'Admin' })
        .getByRole('link', { name: /^Orders/ })
        .filter({ visible: true })
        .first(),
    ).toHaveAttribute('aria-current', 'page')

    // Searched by its number, it is the only one, with the buyer masked and the facts in words.
    await page.goto(`/admin/orders?q=${order.number}`)
    await expect(page.getByRole('heading', { level: 2, name: '1 order' })).toBeVisible()
    const masked = `${customer.email[0]}•••@example.com`
    await expect(page.getByRole('link', { name: masked }).first()).toBeVisible()
    await expect(
      page.getByText('Registration', { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible()
    const invoice = page
      .getByText(/^TEST-INV-\d+$/)
      .filter({ visible: true })
      .first()
    await expect(invoice).toBeVisible()
    const invoiceNumber = (await invoice.textContent()) ?? ''
    // The page never shows the buyer's address unmasked.
    expect(await page.content()).not.toContain(customer.email)

    // By its domain, and by its invoice, it is found the same way.
    for (const q of [order.domain, invoiceNumber]) {
      await page.goto(`/admin/orders?q=${q}`)
      await expect(page.getByRole('link', { name: order.number, exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { level: 2, name: '1 order' })).toBeVisible()
    }
  })

  test('sorts and pages from the URL', async () => {
    await page.goto('/admin/orders')
    // Table headers from xl; sort links above the cards below it.
    const total = page.getByRole('link', { name: /^Total/ }).first()
    await total.click()
    await expect(page).toHaveURL(/[?&]sort=total(&|$)/)
    const sorted = page.locator('th[aria-sort="descending"]', { hasText: 'Total' })
    const current = page.getByRole('navigation', { name: 'Sort orders' }).getByRole('link', {
      name: /^Total/,
    })
    if (await sorted.isVisible()) {
      await expect(sorted).toBeVisible()
    } else {
      await expect(current).toHaveAttribute('aria-current', 'true')
    }

    await page
      .getByRole('link', { name: /^Total.*reverse/ })
      .first()
      .click()
    await expect(page).toHaveURL(/[?&]dir=asc(&|$)/)

    // Past the last page: said so, with the way back.
    await page.goto('/admin/orders?page=9999')
    await expect(page.getByText('Nothing on page 9999.')).toBeVisible()
    await page.getByRole('link', { name: 'Go to the first page' }).click()
    await expect(page).toHaveURL(/\/admin\/orders$/)
    await expect(page.getByText(/in all$/)).toBeVisible()
  })

  test('?q= never takes an email', async () => {
    if (!customer) throw new Error('no customer')
    await page.goto('/admin/orders')
    const box = page.getByRole('searchbox', { name: 'Search orders' })
    await box.fill(customer.email)
    await box.press('Enter')
    // The browser refuses the pattern: nothing is sent, so no email reaches the URL.
    expect(await box.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(
      true,
    )
    await expect(page).toHaveURL(/\/admin\/orders$/)
    expect(page.url()).not.toContain('@')
    expect(page.url()).not.toContain('%40')

    // An email that arrives anyway is not searched, nor kept in any link or the box.
    await page.goto(`/admin/orders?q=${encodeURIComponent(customer.email)}`)
    await expect(page.getByText(EMAIL_REFUSED)).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to Customers' })).toHaveAttribute(
      'href',
      '/admin/customers',
    )
    await expect(page.getByRole('searchbox', { name: 'Search orders' })).toHaveValue('')
    const hrefs = await page
      .locator('main a[href^="/admin/orders"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))
    for (const href of hrefs) {
      expect(href).not.toContain('@')
      expect(href).not.toContain('%40')
    }
    await expect(page.locator('main table')).toHaveCount(0)
  })

  test('the detail shows lines with renewal prices, recorded cost, payments with fees and the call trace', async () => {
    if (!order) throw new Error('no order')
    await page.goto(`/admin/orders?q=${order.number}`)
    await page.getByRole('link', { name: order.number, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/orders/${order.id}$`))
    await expect(
      page.getByRole('heading', { level: 1, name: `Order ${order.number}` }),
    ).toBeVisible()
    await expect(page.getByRole('region', { name: 'Summary' })).toBeVisible()

    const lines = page.getByRole('region', { name: /^Lines/ })
    await expect(lines.getByText(order.domain).filter({ visible: true }).first()).toBeVisible()
    // N8: the price is never without its renewal price.
    await expect(
      lines
        .getByText(/^Renews at ₦[\d,]+(\/yr| every \d+ years)$/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible()
    // D13: the cost as checkout recorded it, or plainly not.
    await expect(
      lines
        .getByText(
          /^(\$[\d,]+\.\d{2}( \+ \$[\d,]+\.\d{2} ICANN)? \(recorded at checkout\)|Not recorded)$/,
        )
        .filter({ visible: true })
        .first(),
    ).toBeVisible()

    // Payments from the masked view: the fee and who paid it, or that Flutterwave did not say.
    const payments = page.getByRole('region', { name: /^Payments/ })
    await expect(
      payments.getByText('Fee', { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible()
    await expect(
      payments.getByText('Fee paid by', { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible()
    await expect(
      payments
        .getByText(/^(₦[\d,]+(\.\d{2})?|Not reported)$/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible()

    // The trace: the registration job, and its supplier calls (or that none are recorded).
    const trace = page.getByRole('region', { name: /^Registry jobs and supplier calls/ })
    await expect(trace.getByRole('link', { name: /^Job [0-9a-f]{8}$/ }).first()).toBeVisible()
    await expect(
      trace.getByText('Registration', { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible()
    await expect(
      trace
        .getByText(/^No supplier calls are recorded for this order’s jobs\.$/)
        .or(trace.getByRole('cell', { name: /^(OK|Not found|Refused|Blocked|Unknown)$/ }))
        .filter({ visible: true })
        .first(),
    ).toBeVisible()

    const activity = page.getByRole('region', { name: /^Domain activity/ })
    await expect(activity.getByText(`Registered · ${order.domain}`)).toBeVisible()
  })

  /** Axe in both themes, then no horizontal overflow from 320 to 1920 px (S3, S5, S8). */
  async function accessible(path: string) {
    const viewport = page.viewportSize()
    try {
      for (const theme of ['light', 'dark'] as const) {
        // The site starts light; a chosen theme is what next-themes keeps.
        await page.goto(path)
        await page.evaluate((value) => localStorage.setItem('theme', value), theme)
        await page.reload()
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        const results = await axe(page)
        expect(results.violations, `${path} in ${theme}`).toEqual([])
      }
      for (const width of [320, 375, 768, 1024, 1440, 1920]) {
        expect(await overflowAt(page, width), `${path} overflows at ${width}`).toBeLessThanOrEqual(
          1,
        )
      }
    } finally {
      await page.evaluate(() => localStorage.setItem('theme', 'light'))
      if (viewport) await page.setViewportSize(viewport)
    }
  }

  test('the list passes axe in both themes, at every width, with no horizontal overflow', async () => {
    test.slow()
    await accessible('/admin/orders')
  })

  test('an order passes axe in both themes, at every width, with no horizontal overflow', async () => {
    test.slow()
    if (!order) throw new Error('no order')
    await accessible(`/admin/orders/${order.id}`)
  })
})
