import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createAdminTestUser,
  deleteTestUser,
  freshTotpCode,
  hasAdminSchema,
  hasSslSchema,
} from './support/accounts.mjs'
import { type AdminUser, expect, SIGN_IN_PROJECTS, signInAsAdmin, test } from './support/admin'

/**
 * The queue (docs/ADMIN-SPEC.md §5.2 B4, §9): a failed test registration is
 * retried with a code — back in the queue, its pending refund cancelled; Fail
 * without a fresh registry read is refused in words, beside the supplier
 * ledger's word (migration 42); the live reads show the mock gateway's
 * answers; a certificate order names its certificate, line and refund; the
 * "Paid, no job" tab renders. A test-only admin, on the test side, with no
 * failure artifacts (support/admin.ts).
 *
 * Seeds are test-mode rows of the admin's own e2e account, written as the
 * payment and the worker write them — record_order_payment, claim_job,
 * fail_job — with the secret key, as accounts.mjs's settle helpers do. The
 * account's deletion removes them (purge_test_orders).
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

type Seeded = { orderId: string; jobId: string; domain: string }

/**
 * A paid test order of one ₦1,000 line (₦1,075 with VAT) for the admin's own
 * e2e account, paid through record_order_payment, which queues its job.
 */
async function paidOrder(
  db: SupabaseClient,
  userId: string,
  kind: 'register' | 'transfer' | 'ssl',
  productCode: string | null = null,
): Promise<{ orderId: string; domain: string }> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const domain = `e2equeue${stamp}.com`
  const { data: rate, error: rateError } = await db.from('fx_rates').select('id').limit(1).single()
  if (rateError) throw rateError
  const { data: order, error } = await db
    .from('orders')
    .insert({
      user_id: userId,
      subtotal_kobo: 100_000,
      vat_pct: 7.5,
      vat_kobo: 7_500,
      total_kobo: 107_500,
      fx_rate_id: rate.id,
      tx_ref: `MDH-e2e-queue-${stamp}`,
      registrant: {},
      float_check: 'covered',
      test_mode: true,
    })
    .select('id')
    .single()
  if (error) throw error
  const line = await db.from('order_items').insert({
    order_id: order.id,
    domain,
    tld: 'com',
    item_type: kind,
    period_years: 1,
    privacy: false,
    auto_renew: false,
    price_kobo: 100_000,
    renewal_kobo: 100_000,
    ...(productCode ? { ssl_product_code: productCode } : {}),
  })
  if (line.error) throw line.error
  const paid = await db.rpc('record_order_payment', {
    p_order_id: order.id,
    p_provider_reference: `queue-${stamp}`,
    p_amount_kobo: 107_500,
    p_currency: 'NGN',
    p_method: 'card',
    p_raw: { id: `queue-${stamp}`, status: 'successful' },
  })
  if (paid.error) throw paid.error
  return { orderId: order.id, domain }
}

/**
 * A paid test registration or transfer, its job claimed and failed the way
 * the worker fails it: `failed` queues the line's refund; `needs_attention`
 * waits for a person.
 */
async function seedJob(
  userId: string,
  kind: 'register' | 'transfer',
  outcome: { code: string; needsAttention: boolean },
): Promise<Seeded> {
  const db = service()
  const { orderId, domain } = await paidOrder(db, userId, kind)
  const { data: jobs, error: jobsError } = await db
    .from('jobs')
    .select('id, order_items!inner(order_id)')
    .eq('order_items.order_id', orderId)
  if (jobsError) throw jobsError
  const job = jobs?.[0]
  if (!job) throw new Error(`no job for order ${orderId}`)
  const claim = await db.rpc('claim_job', {
    p_worker: 'e2e',
    p_test_mode: true,
    p_job_id: job.id,
  })
  if (claim.error) throw claim.error
  const failed = await db.rpc('fail_job', {
    p_job_id: job.id,
    p_code: outcome.code,
    p_message: 'e2e',
    p_needs_attention: outcome.needsAttention,
  })
  if (failed.error) throw failed.error
  return { orderId, jobId: job.id, domain }
}

/**
 * A paid test certificate order whose order job timed out at the supplier
 * before it was sent: it waits for a person, and Fail is offered.
 */
async function seedSslJob(userId: string): Promise<Seeded> {
  const db = service()
  const { data: product, error: productError } = await db
    .from('ssl_products')
    .select('product_code')
    .eq('is_sellable', true)
    .not('create_usd', 'is', null)
    .limit(1)
    .single()
  if (productError) throw productError
  const { orderId, domain } = await paidOrder(db, userId, 'ssl', product.product_code)
  const { data: job, error } = await db
    .from('ssl_jobs')
    .select('id, ssl_certificates!inner(order_items!inner(order_id))')
    .eq('ssl_certificates.order_items.order_id', orderId)
    .single()
  if (error) throw error
  const claim = await db.rpc('claim_ssl_job', {
    p_worker: 'e2e',
    p_test_mode: true,
    p_job_id: job.id,
  })
  if (claim.error) throw claim.error
  const failed = await db.rpc('fail_ssl_job', {
    p_job_id: job.id,
    p_code: 'SUPPLIER_TIMEOUT',
    p_message: 'e2e',
    p_needs_attention: true,
  })
  if (failed.error) throw failed.error
  return { orderId, jobId: job.id, domain }
}

async function jobStatus(jobId: string): Promise<string | null> {
  const { data } = await service().from('jobs').select('status').eq('id', jobId).single()
  return data?.status ?? null
}

async function lineRefunds(orderId: string): Promise<{ id: string; status: string }[]> {
  const { data } = await service().from('refunds').select('id, status').eq('order_id', orderId)
  return data ?? []
}

async function auditRows(jobId: string, action: string) {
  const { data } = await service()
    .from('admin_audit_log')
    .select('outcome, error_code')
    .eq('target_id', jobId)
    .eq('action', action)
  return data ?? []
}

/**
 * A code from a later window than the one signing in used: a money dialog
 * verifies its own code, and the authenticator's last one may not count twice.
 */
async function nextCode(secret: string, after: number): Promise<string> {
  while (Math.floor(Date.now() / 30_000) <= after) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return freshTotpCode(secret)
}

const window30 = () => Math.floor(Date.now() / 30_000)

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

test.describe('the queue to anyone who is not an admin', () => {
  test('every queue page is the plain 404', async ({ page }) => {
    for (const path of [
      '/admin/queue',
      '/admin/queue/pending',
      '/admin/queue/ssl-jobs',
      '/admin/queue/jobs/00000000-0000-4000-8000-000000000000',
    ]) {
      const response = await page.goto(path)
      expect(response?.status(), path).toBe(404)
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Queue' })).toHaveCount(0)
    }
  })
})

test.describe('the queue to a test administrator', () => {
  let admin: AdminUser | undefined

  test.beforeEach(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migrations 40–41 are not applied to this database')
    admin = (await createAdminTestUser('queue')) as AdminUser
  })
  test.afterEach(async () => {
    if (admin) await deleteTestUser(admin.user.id)
    admin = undefined
  })

  test('a failed registration is retried with a code: back in the queue, its refund cancelled', async ({
    page,
  }) => {
    if (!admin) throw new Error('no admin')
    const seeded = await seedJob(admin.user.id, 'register', {
      code: 'DOMAIN_TAKEN',
      needsAttention: false,
    })
    const [queued] = await lineRefunds(seeded.orderId)
    expect(queued?.status).toBe('queued')

    await signInAsAdmin(page, admin, '/admin/queue')
    const signedInWindow = window30()
    await expect(page.getByRole('heading', { level: 1, name: 'Queue' })).toBeVisible()
    await expect(
      page
        .getByRole('navigation', { name: 'Queue lists' })
        .getByRole('link', { name: 'Jobs', exact: true }),
    ).toHaveAttribute('aria-current', 'page')

    // The failed job is listed under its status; the list's link opens it.
    await page
      .getByRole('navigation', { name: 'Status' })
      .getByRole('link', { name: 'Failed' })
      .click()
    await expect(page).toHaveURL(/\/admin\/queue\?status=failed$/)
    const row = page.getByRole('link', { name: new RegExp(`Registration\\s*${seeded.domain}`) })
    await expect(row).toBeVisible()
    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)

    await row.click()
    await expect(page).toHaveURL(new RegExp(`/admin/queue/jobs/${seeded.jobId}$`))
    await expect(page.getByRole('heading', { level: 1, name: seeded.domain })).toBeVisible()
    // A failed registration's Fail is not offered: it is already failed.
    await expect(page.getByRole('button', { name: 'Fail', exact: true })).toHaveCount(0)
    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)

    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', { name: `Try the registration of ${seeded.domain} again?` }),
    ).toBeVisible()
    await expect(dialog).toContainText('Its pending refund of ₦1,075 is cancelled first')
    await dialog.getByLabel('Reason').fill('e2e: the registry read shows it free again')
    await dialog
      .getByLabel('Code from your authenticator app')
      .fill(await nextCode(admin.totpSecret, signedInWindow))
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(
      dialog.getByText('Back in the queue: the worker takes it on its next run.'),
    ).toBeVisible()

    await expect.poll(() => jobStatus(seeded.jobId)).toBe('queued')
    await expect
      .poll(async () => (await lineRefunds(seeded.orderId)).map((refund) => refund.status))
      .toEqual(['cancelled'])
    const audited = await auditRows(seeded.jobId, 'job.retry')
    expect(audited.filter((entry) => entry.outcome === 'ok')).toHaveLength(1)

    await dialog.getByRole('button', { name: 'Close' }).click()
    const summary = page.getByRole('region', { name: 'Summary' })
    await expect(summary.getByText('Queued', { exact: true })).toBeVisible()
    await expect(
      page
        .getByRole('region', { name: 'Order line and refund' })
        .getByText('Cancelled', { exact: true }),
    ).toBeVisible()
  })

  test('Fail without a fresh registry read is refused in words, and the registry read shows the mock', async ({
    page,
  }) => {
    if (!admin) throw new Error('no admin')
    const seeded = await seedJob(admin.user.id, 'register', {
      code: 'SUPPLIER_TIMEOUT',
      needsAttention: true,
    })

    await signInAsAdmin(page, admin, `/admin/queue/jobs/${seeded.jobId}`)
    const signedInWindow = window30()
    await expect(page.getByRole('heading', { level: 1, name: seeded.domain })).toBeVisible()
    const before = page.getByRole('region', { name: 'Before failing' })
    await expect(before).toContainText('No registry read is recorded for this domain on this side.')
    // The ledger's word (admin_job_ledger): a job this new can show no charge,
    // whether or not the test side's ledger has been read since it started.
    const ledger = before.locator('[data-ledger]')
    await expect(ledger).toHaveAttribute('data-ledger', /^(never_read|before_job|clear)$/)
    await expect(ledger).toContainText(seeded.domain)
    expect((await axe(page)).violations).toEqual([])

    // The mock gateway answers "not in our account"; it records no call, so Fail still needs one.
    await before.getByRole('button', { name: 'Read the registry now' }).click()
    await expect(before.getByRole('status')).toHaveText('Read at 12:05 WAT: not in our account')

    await page.getByRole('button', { name: 'Fail', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', {
        name: `Fail the registration of ${seeded.domain} and refund ₦1,075?`,
      }),
    ).toBeVisible()
    // Destructive: Cancel has the focus first.
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await dialog.getByLabel('Reason').fill('e2e: the registry does not have it')
    await dialog.getByLabel(`Type ${seeded.domain} to confirm`).fill(seeded.domain)
    await dialog
      .getByLabel('Code from your authenticator app')
      .fill(await nextCode(admin.totpSecret, signedInWindow))
    await dialog.getByRole('button', { name: 'Fail and refund ₦1,075' }).click()
    await expect(
      dialog.getByText(
        'Read the registry first: it must show the domain is not in our account, after the last registration attempt and in the last 15 minutes.',
      ),
    ).toBeVisible()

    // Refused: nothing moved, and the refusal is in the audit log.
    expect(await jobStatus(seeded.jobId)).toBe('needs_attention')
    expect(await lineRefunds(seeded.orderId)).toEqual([])
    const refused = await auditRows(seeded.jobId, 'job.fail')
    expect(refused).toEqual([{ outcome: 'refused', error_code: 'READ_REGISTRY_FIRST' }])
  })

  test('a waiting transfer reads its state from the mock; the paid-no-job tab renders', async ({
    page,
  }) => {
    if (!admin) throw new Error('no admin')
    const seeded = await seedJob(admin.user.id, 'transfer', {
      code: 'TRANSFER_OVERDUE',
      needsAttention: true,
    })

    await signInAsAdmin(page, admin, `/admin/queue/jobs/${seeded.jobId}`)
    await expect(page.getByRole('heading', { level: 1, name: seeded.domain })).toBeVisible()
    await expect(page.getByText('TRANSFER_OVERDUE').first()).toBeVisible()
    const before = page.getByRole('region', { name: 'Before failing' })
    await before.getByRole('button', { name: 'Read the transfer state' }).click()
    // WebKit's en-GB writes September "Sep", Chromium's "Sept".
    await expect(before.getByRole('status')).toHaveText(
      /^Read at 12:05 WAT: refused by the registry on 30 Sept? 2026$/,
    )
    expect((await axe(page)).violations).toEqual([])

    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Queue', exact: true })
      .click()
    await page
      .getByRole('navigation', { name: 'Queue lists' })
      .getByRole('link', { name: 'Paid, no job' })
      .click()
    await expect(page).toHaveURL(/\/admin\/queue\/pending$/)
    const pending = page.getByRole('region', { name: 'Paid, no job' })
    await expect(pending).toContainText('Nothing on this page queues a job.')
    await expect(
      page
        .getByRole('navigation', { name: 'Queue lists' })
        .getByRole('link', { name: 'Paid, no job' }),
    ).toHaveAttribute('aria-current', 'page')
    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)
  })

  test('a certificate order waiting for a person names its certificate, line and refund', async ({
    page,
  }) => {
    if (!admin) throw new Error('no admin')
    test.skip(!(await hasSslSchema()), 'no sellable, priced certificate on this database')
    const seeded = await seedSslJob(admin.user.id)

    await signInAsAdmin(page, admin, `/admin/queue/ssl-jobs/${seeded.jobId}`)
    // Named by its certificate (admin_ssl_job_certificate), not by an id.
    await expect(page.getByRole('heading', { level: 1, name: seeded.domain })).toBeVisible()
    const line = page.getByRole('region', { name: 'Order line and refund' })
    await expect(line.getByText('Certificate', { exact: true })).toBeVisible()
    await expect(line).toContainText('₦1,000 for a 1-year subscription')
    await expect(line).toContainText('No refund for this line.')
    await expect(line.getByRole('link').first()).toHaveAttribute(
      'href',
      `/admin/orders/${seeded.orderId}`,
    )
    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)

    // Never sent, so Fail is offered, naming the refund it queues: price and VAT share.
    await page.getByRole('button', { name: 'Fail', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', { name: `Fail the certificate order for ${seeded.domain}?` }),
    ).toBeVisible()
    await expect(dialog).toContainText(
      'a refund of ₦1,075 is queued to the card or account that paid',
    )
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
