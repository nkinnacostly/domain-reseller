import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createAdminTestUser,
  createTestUser,
  deleteTestUser,
  hasAdminSchema,
} from './support/accounts.mjs'
import { type AdminUser, expect, signInAsAdmin, test } from './support/admin'

/**
 * The customers pages (docs/ADMIN-SPEC.md §5.2, §9 B8), as a test-only
 * operator on the Test side: the totals are not shown, the list holds only
 * e2e accounts with their emails masked, a search by exact email is a POST
 * whose address never holds the email, and "Show contact details" reveals
 * one account, writes one `customer.reveal` audit row, and is forgotten when
 * the page is left. Every account here is an e2e-*@example.com user (D15).
 */

/** One desktop and one phone: sign-ins are rate-limited per address. */
const PROJECTS = ['chromium-desktop', 'mobile-android']

const FULL_NAME = 'Cust Omer'
const MASKED = /^e•••@example\.com$/

type TestUser = { id: string; email: string; password: string }

/** The secret-key client, to read back what the audit log recorded. */
function service(): SupabaseClient {
  const path = fileURLToPath(new URL('../../../../.env', import.meta.url))
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key && !process.env[key]) process.env[key] = rest.join('=').replace(/^["']|["']$/g, '')
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/** This admin's audit rows for one action. */
async function auditRows(adminId: string, action: string) {
  const { data, error } = await service()
    .from('admin_audit_log')
    .select('outcome, target_id, test_actor, detail')
    .eq('admin_id', adminId)
    .eq('action', action)
  if (error) throw error
  return data ?? []
}

const shortId = (id: string) => id.replace(/-/g, '').slice(0, 8)

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

test.describe.configure({ mode: 'serial' })

test.describe('the customers pages, as a test administrator', () => {
  let customer: TestUser | undefined
  let admin: AdminUser | undefined
  let contexts: BrowserContext[] = []
  let page: Page

  test.beforeAll(async ({ browser }, info) => {
    test.skip(!PROJECTS.includes(info.project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migrations 40–41 are not applied to this database')
    test.setTimeout(180_000)
    customer = (await createTestUser('customer', { fullName: FULL_NAME })) as TestUser
    admin = (await createAdminTestUser('customers')) as AdminUser
    // The runner gives a new context the project's device and base address.
    const context = await browser.newContext()
    contexts.push(context)
    page = await context.newPage()
    await signInAsAdmin(page, admin, '/admin/customers')
  })

  test.afterAll(async () => {
    for (const context of contexts) await context.close()
    contexts = []
    // A statement timeout on a busy shared database gets one more try.
    for (const id of [customer?.id, admin?.user.id]) {
      if (id) await deleteTestUser(id).catch(() => deleteTestUser(id))
    }
    customer = undefined
    admin = undefined
  })

  test('the totals are not shown, and the list holds only e2e accounts, masked', async () => {
    if (!customer || !admin) throw new Error('no users')
    await page.goto('/admin/customers')
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible()
    await expect(
      main.getByRole('region', { name: 'Accounts' }).getByText('Not shown to test administrators.'),
    ).toBeVisible()

    // The sidebar marks the page (S13); on a phone it is a drawer. It streams
    // in on its own, so wait for it or the drawer's button first.
    const sidebar = page.getByRole('navigation', { name: 'Admin' }).filter({ visible: true })
    const menu = page.getByRole('button', { name: 'Open menu' }).filter({ visible: true })
    await expect(sidebar.or(menu).first()).toBeVisible()
    if ((await sidebar.count()) === 0) await menu.click()
    await expect(
      page
        .getByRole('navigation', { name: 'Admin' })
        .getByRole('link', { name: /^Customers/ })
        .filter({ visible: true })
        .first(),
    ).toHaveAttribute('aria-current', 'page')
    await page.goto('/admin/customers')

    // Every row is an e2e account, masked; no customer's full address is on the page.
    const masked = await page
      .locator('main [data-masked-email]')
      .filter({ visible: true })
      .allTextContents()
    expect(masked.length).toBeGreaterThan(0)
    for (const value of masked) expect(value.trim()).toMatch(MASKED)
    expect(await page.content()).not.toContain(customer.email)
    // The admin's own address shows only in the sidebar's account menu, never in the list.
    expect(await page.getByRole('main').innerText()).not.toContain(admin.user.email)

    // Sorting is a link: the URL says how the list is ordered.
    await page
      .getByRole('link', { name: /^Domains held/ })
      .filter({ visible: true })
      .first()
      .click()
    await expect(page).toHaveURL(/[?&]sort=domains(&|$)/)
    await expect(page.getByRole('heading', { level: 2, name: /^All customers/ })).toBeVisible()
  })

  test('a search by exact email is a POST, and no address ever holds it', async () => {
    if (!customer || !admin) throw new Error('no users')
    await page.goto('/admin/customers')
    const sent: { url: string; method: string }[] = []
    page.on('request', (request) => sent.push({ url: request.url(), method: request.method() }))

    const form = page.locator('form[data-enhanced="true"]')
    await expect(form).toBeVisible()
    await form
      .getByRole('searchbox', { name: 'Email, order number or domain' })
      .fill(customer.email)
    const answer = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/admin/customers',
    )
    await form.getByRole('button', { name: 'Search', exact: true }).click()
    expect((await answer).status()).toBe(200)

    const found = page.getByRole('link', { name: `Account ${shortId(customer.id)}` })
    await expect(found.filter({ visible: true }).first()).toBeVisible()
    await expect(page.getByText(/^1 customer matches exactly\.$/)).toBeVisible()

    // The search went in a POST body: no request, and no address, carried the email.
    expect(sent.some((request) => request.method === 'POST')).toBe(true)
    for (const request of [...sent, { url: page.url(), method: 'GET' }]) {
      expect(request.url).not.toContain('@')
      expect(request.url).not.toContain('%40')
    }

    // One recorded search, of an email, naming the account matched — never what was typed.
    const rows = await auditRows(admin.user.id, 'customer.search')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'ok', test_actor: true })
    expect(rows[0]?.detail).toMatchObject({ kind: 'email', matched: [customer.id] })
    expect(JSON.stringify(rows[0])).not.toContain(customer.email)
  })

  test('"Show contact details" reveals, writes one customer.reveal row, and leaving clears it', async () => {
    if (!customer || !admin) throw new Error('no users')
    await page.goto(`/admin/customers/${customer.id}`)
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(MASKED)
    await expect(main.getByText(customer.email)).toHaveCount(0)

    await main.getByRole('button', { name: 'Show contact details' }).click()
    const dialog = page.getByRole('dialog', { name: 'Show this customer’s contact details?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Your view is recorded in the audit log.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Show contact details' }).click()

    const contact = main.locator('[data-revealed]')
    await expect(contact.getByText(customer.email, { exact: true })).toBeVisible()
    await expect(contact.getByText(FULL_NAME, { exact: true })).toBeVisible()
    await expect(dialog).toBeHidden()

    const reveals = await auditRows(admin.user.id, 'customer.reveal')
    expect(reveals).toHaveLength(1)
    expect(reveals[0]).toMatchObject({ outcome: 'ok', target_id: customer.id, test_actor: true })

    // Leaving for another tab, then coming back: the details are gone, not just hidden.
    await page
      .getByRole('navigation', { name: 'Customer' })
      .getByRole('link', { name: /^Orders/ })
      .click()
    await expect(page).toHaveURL(new RegExp(`/admin/customers/${customer.id}/orders$`))
    await expect(main.getByText('No orders from this customer on the Test side.')).toBeVisible()
    expect(await page.content()).not.toContain(customer.email)

    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/admin/customers/${customer.id}$`))
    await expect(main.getByRole('button', { name: 'Show contact details' })).toBeVisible()
    await expect(main.getByText(customer.email)).toHaveCount(0)
    expect(await page.content()).not.toContain(customer.email)
    // Coming back showed nothing new: still one recorded view.
    expect(await auditRows(admin.user.id, 'customer.reveal')).toHaveLength(1)
  })

  test('the other tabs say what they hold, and an unknown account is said plainly', async () => {
    if (!customer) throw new Error('no customer')
    const main = page.getByRole('main')
    await page.goto(`/admin/customers/${customer.id}/domains`)
    await expect(
      main.getByRole('link', { name: 'Domains', exact: true }).filter({ visible: true }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(
      main.getByText('No domains on this customer’s orders on the Test side.'),
    ).toBeVisible()

    await page.goto(`/admin/customers/${customer.id}/certificates`)
    await expect(
      main.getByText('No certificates on this customer’s orders on the Test side.'),
    ).toBeVisible()

    await page.goto(`/admin/customers/${customer.id}/emails`)
    await expect(main.getByText('This customer’s emails aren’t listed here yet.')).toBeVisible()
    await expect(main.getByRole('link', { name: 'Go to Emails' })).toHaveAttribute(
      'href',
      '/admin/emails',
    )

    await page.goto('/admin/customers/00000000-0000-4000-8000-000000000000')
    await expect(main.getByText('No customer with this id.')).toBeVisible()
    await expect(main.getByRole('link', { name: 'Back to customers' })).toBeVisible()
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
    await accessible('/admin/customers')
  })

  test('a customer passes axe in both themes, at every width, with no horizontal overflow', async () => {
    test.slow()
    if (!customer) throw new Error('no customer')
    await accessible(`/admin/customers/${customer.id}`)
  })
})
