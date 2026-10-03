import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createAdminTestUser,
  deleteTestUser,
  hasAdminSchema,
  hasSslSchema,
  issueSslCertificate,
  settleSslOrder,
  settleSslSetup,
} from './support/accounts.mjs'
import { type AdminUser, expect, SIGN_IN_PROJECTS, signInAsAdmin, test } from './support/admin'
import { mockCertificate, mockCsr } from './support/ssl.mjs'

/**
 * The certificate pages (docs/ADMIN-SPEC.md §5.2 B10, §9): the list and one
 * certificate, as a test-only operator on the Test side, with no failure
 * artifacts (support/admin.ts). The approver is masked; "Check status now"
 * reads the mock gateway after an audited note; no copy calls a certificate
 * valid for a year (CLAUDE.md §15). The enrolled journeys skip until the
 * SSL schema and a sellable product exist (`hasSslSchema()`).
 *
 * The seed is one test-mode certificate of the admin's own e2e account,
 * written as the payment, the gateway and the customer write it —
 * record_order_payment, settleSslOrder, request_ssl_setup, settleSslSetup,
 * issueSslCertificate — with the secret key. The account's deletion removes it.
 */

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

type Seeded = { orderId: string; certificateId: string; name: string; approver: string }

/** An issued test certificate for the admin's own account, set up with an approval address. */
async function seedCertificate(userId: string): Promise<Seeded> {
  const db = service()
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const name = `e2essl${stamp}.com`
  const approver = `admin@${name}`
  const { data: product, error: productError } = await db
    .from('ssl_products')
    .select('product_code')
    .eq('is_sellable', true)
    .eq('is_wildcard', false)
    .not('create_usd', 'is', null)
    .limit(1)
    .single()
  if (productError) throw productError
  const { data: rate, error: rateError } = await db.from('fx_rates').select('id').limit(1).single()
  if (rateError) throw rateError
  const { data: order, error } = await db
    .from('orders')
    .insert({
      user_id: userId,
      subtotal_kobo: 1_350_000,
      vat_pct: 7.5,
      vat_kobo: 101_250,
      total_kobo: 1_451_250,
      fx_rate_id: rate.id,
      tx_ref: `MDH-e2e-ssl-${stamp}`,
      registrant: {},
      float_check: 'covered',
      test_mode: true,
    })
    .select('id')
    .single()
  if (error) throw error
  const line = await db.from('order_items').insert({
    order_id: order.id,
    domain: name,
    tld: 'com',
    item_type: 'ssl',
    period_years: 1,
    privacy: false,
    auto_renew: false,
    price_kobo: 1_350_000,
    renewal_kobo: 1_350_000,
    ssl_product_code: product.product_code,
  })
  if (line.error) throw line.error
  const paid = await db.rpc('record_order_payment', {
    p_order_id: order.id,
    p_provider_reference: `ssl-${stamp}`,
    p_amount_kobo: 1_451_250,
    p_currency: 'NGN',
    p_method: 'card',
    p_raw: { id: `ssl-${stamp}`, status: 'successful' },
  })
  if (paid.error) throw paid.error
  const [certificateId] = (await settleSslOrder(order.id, 'bought')) as string[]
  if (!certificateId) throw new Error(`no certificate for order ${order.id}`)
  const setup = await db.rpc('request_ssl_setup', {
    p_user_id: userId,
    p_certificate_id: certificateId,
    p_csr: mockCsr(name),
    p_approver_email: approver,
    p_web_server: 'apache',
    p_san_names: [],
    p_contact: { firstName: 'Test', lastName: 'Admin', country: 'NG' },
  })
  if (setup.error) throw setup.error
  await settleSslSetup(certificateId)
  await issueSslCertificate(certificateId, mockCertificate(name), mockCertificate('e2e chain'))
  return { orderId: order.id, certificateId, name, approver }
}

async function lookupNotes(name: string) {
  const { data } = await service()
    .from('admin_audit_log')
    .select('outcome, side')
    .eq('action', 'supplier.ssl_lookup')
    .eq('target_id', name)
  return data ?? []
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

/** No horizontal overflow from 320 to 1920 px; the project's own viewport is put back after. */
async function expectNoOverflow(page: Page) {
  const original = page.viewportSize()
  for (const width of [320, 375, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `overflow at ${width}`).toBeLessThanOrEqual(1)
  }
  if (original) await page.setViewportSize(original)
}

/** "Valid for a year", in any of its forms: a certificate lasts at most 200 days (§15). */
const YEAR_OF_VALIDITY = /valid for (a|one|1) year|year of validity/i

test.describe('the certificate pages to anyone who is not an admin', () => {
  test('both are the plain 404', async ({ page }) => {
    for (const path of ['/admin/ssl', '/admin/ssl/00000000-0000-4000-8000-000000000000']) {
      const response = await page.goto(path)
      expect(response?.status(), path).toBe(404)
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Certificates' })).toHaveCount(0)
    }
  })
})

test.describe.configure({ mode: 'serial' })

test.describe('the certificate pages, as a test administrator', () => {
  let admin: AdminUser | undefined
  let seeded: Seeded | undefined
  let contexts: BrowserContext[] = []
  let page: Page

  test.beforeAll(async ({ browser }, info) => {
    test.skip(!SIGN_IN_PROJECTS.includes(info.project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migrations 40–41 are not applied to this database')
    test.skip(!(await hasSslSchema()), 'no SSL schema or sellable certificate on this database')
    test.setTimeout(180_000)

    admin = (await createAdminTestUser('ssl')) as AdminUser
    seeded = await seedCertificate(admin.user.id)

    // The project's own device: its viewport, and on a phone the drawer.
    const context = await browser.newContext()
    contexts.push(context)
    page = await context.newPage()
    await signInAsAdmin(page, admin, '/admin/ssl')
  })

  test.afterAll(async () => {
    for (const context of contexts) await context.close()
    contexts = []
    // A statement timeout on a busy shared database gets one more try.
    const id = admin?.user.id
    if (id) await deleteTestUser(id).catch(() => deleteTestUser(id))
    admin = undefined
    seeded = undefined
  })

  test('the list shows the seeded certificate on the Test side, and the sidebar marks the page', async () => {
    if (!seeded) throw new Error('no certificate')
    await page.goto('/admin/ssl')
    await expect(page.getByRole('heading', { level: 1, name: 'Certificates' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'At a glance' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Paid, no certificate' })).toBeVisible()
    await expect(page.getByRole('link', { name: seeded.name, exact: true }).first()).toBeVisible()

    // The sidebar marks the page (S13); on a phone it is a drawer.
    const nav = page.getByRole('navigation', { name: 'Admin' }).first()
    if (!(await nav.isVisible())) await page.getByRole('button', { name: 'Open menu' }).click()
    await expect(
      page
        .getByRole('navigation', { name: 'Admin' })
        .getByRole('link', { name: /^Certificates/ })
        .filter({ visible: true })
        .first(),
    ).toHaveAttribute('aria-current', 'page')
    await page.goto('/admin/ssl')

    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)

    // Searched by its name it is the only one, issued, in our words.
    await page.goto(`/admin/ssl?q=${seeded.name}&status=issued`)
    await expect(page.getByRole('heading', { level: 2, name: '1 certificate' })).toBeVisible()
    await expect(
      page.getByRole('navigation', { name: 'Certificate status' }).getByRole('link', {
        name: /^Issued/,
      }),
    ).toHaveAttribute('aria-current', 'true')
    await expect(
      page.getByText('Active', { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible()

    // An email that arrives in the URL is not searched, nor kept in any link or the box (N13).
    await page.goto(`/admin/ssl?q=${encodeURIComponent(seeded.approver)}`)
    await expect(page.getByText(/certificates are never looked up by email/)).toBeVisible()
    await expect(page.getByRole('searchbox', { name: 'Search certificates' })).toHaveValue('')
    const hrefs = await page
      .locator('main a[href^="/admin/ssl"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))
    for (const href of hrefs) {
      expect(href).not.toContain('@')
      expect(href).not.toContain('%40')
    }
    expect(await page.locator('main').innerText()).not.toMatch(YEAR_OF_VALIDITY)
  })

  test('one certificate: the approver masked, its text, its jobs, and no year of validity', async () => {
    if (!seeded) throw new Error('no certificate')
    await page.goto(`/admin/ssl?q=${seeded.name}`)
    await page.getByRole('link', { name: seeded.name, exact: true }).first().click()
    await expect(page).toHaveURL(new RegExp(`/admin/ssl/${seeded.certificateId}$`))
    await expect(page.getByRole('heading', { level: 1, name: seeded.name })).toBeVisible()

    const setup = page.getByRole('region', { name: 'Set-up' })
    await expect(setup).toContainText(`a•••@${seeded.name}`)
    await expect(setup).toContainText('The private key is never stored or shown here')
    // The address itself is nowhere on the page, nor in what the server sent.
    expect(await page.content()).not.toContain(seeded.approver)

    const term = page.getByRole('region', { name: 'Term' })
    await expect(term).toContainText('1-year subscription')
    await expect(term).toContainText('Certificates now last at most 200 days')
    await expect(term).toContainText('It never renews by itself')
    expect(await page.locator('main').innerText()).not.toMatch(YEAR_OF_VALIDITY)

    const text = page.getByRole('region', { name: 'Certificate text' })
    await text.getByText('Certificate (PEM)').click()
    await expect(text.getByText('-----BEGIN CERTIFICATE-----').first()).toBeVisible()

    const jobs = page.getByRole('region', { name: 'Jobs' })
    await expect(
      jobs.getByRole('link', { name: 'Certificate order' }).filter({ visible: true }),
    ).toHaveAttribute('href', /\/admin\/queue\/ssl-jobs\/[0-9a-f-]{36}$/)
    await expect(
      jobs.getByRole('link', { name: 'Certificate set-up' }).filter({ visible: true }),
    ).toBeVisible()

    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)
  })

  test('"Check status now" reads the mock after one audited note, and says what it found', async () => {
    if (!seeded) throw new Error('no certificate')
    await page.goto(`/admin/ssl/${seeded.certificateId}`)
    const live = page.getByRole('region', { name: 'Read from DomainNameAPI' })
    await expect(live).toContainText('No admin has read its status from DomainNameAPI yet.')
    // Nothing was read on render (D22).
    expect(await lookupNotes(seeded.name)).toEqual([])

    await live.getByRole('button', { name: 'Check status now' }).click()
    // The mock gateway knows no certificate under any name.
    await expect(live.getByRole('status')).toHaveText(
      'Read at 12:05 WAT: DomainNameAPI has no certificate under this name',
    )
    await expect
      .poll(() => lookupNotes(seeded?.name ?? ''))
      .toEqual([{ outcome: 'intent', side: 'test' }])
    expect((await axe(page)).violations).toEqual([])
  })
})
