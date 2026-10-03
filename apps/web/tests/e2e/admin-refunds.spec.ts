import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createAdminTestUser,
  createTestUser,
  deleteTestUser,
  hasAdminSchema,
} from './support/accounts.mjs'
import {
  type AdminUser,
  codeAfter,
  expect,
  SIGN_IN_PROJECTS,
  signInAsAdmin,
  test,
  wrongCode,
} from './support/admin'
import { holdTestRefund, seedPaidTestOrder, settleTestJob } from './support/admin-seed.mjs'

/**
 * Refunds and incidents in the admin area (ADMIN-SPEC §5.2 B3, §9). A test
 * administrator — a test-only operator, on the Test side — approves a test
 * refund held by `hold_test_refund`, through the dialog with a reason and a
 * fresh code: a wrong code changes nothing and writes nothing; a double
 * submit approves once and writes one audit row. Cancel, the owner's, is
 * never shown. Every refund here belongs to an e2e-*@example.com user, in
 * test mode: no real money and no live row is touched (N12).
 */

const WRONG_CODE_WORDS = "That code didn't work. Check your authenticator app and try again."
const REASON = 'e2e: checked the order, the domain was taken'

type TestUser = { id: string; email: string; password: string }
type Seeded = { orderId: string; orderNumber: string; refundId: string; amountKobo: number }

/** The secret-key client, for seeding test rows and reading back what happened. */
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

/**
 * A paid test order for an e2e user whose one line failed, so its refund is
 * queued, then held as if over the limit (§8.1's seed: `seedPaidTestOrder`,
 * the job failed as the worker fails it, `hold_test_refund`).
 */
async function seedHeldRefund(userId: string): Promise<Seeded> {
  const order = await seedPaidTestOrder(userId, { tag: 'refunds' })
  await settleTestJob(order.orderId, { code: 'DOMAIN_TAKEN', needsAttention: false })
  const { data: refund, error: refundError } = await service()
    .from('refunds')
    .select('id, status, amount_kobo')
    .eq('order_id', order.orderId)
    .single()
  if (refundError) throw refundError
  // Over the daily limit already, it is held as it is.
  if (refund.status === 'queued') await holdTestRefund(refund.id)
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    refundId: refund.id,
    amountKobo: Number(refund.amount_kobo),
  }
}

async function refundRow(refundId: string) {
  const { data, error } = await service()
    .from('refunds')
    .select('status, approved_by')
    .eq('id', refundId)
    .single()
  if (error) throw error
  return data
}

/** What the audit log holds for approvals of this refund. */
async function approvals(refundId: string) {
  const { data, error } = await service()
    .from('admin_audit_log')
    .select('outcome, error_code, admin_label, test_actor')
    .eq('action', 'refund.approve')
    .eq('target_id', refundId)
  if (error) throw error
  return data ?? []
}

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

async function expectNoOverflow(page: Page) {
  const original = page.viewportSize()
  for (const width of [320, 375, 768, 1024, 1440, 1920]) {
    expect(await overflowAt(page, width), `overflow at ${width}`).toBeLessThanOrEqual(1)
  }
  if (original) await page.setViewportSize(original)
}

test.describe('refunds, as a test administrator', () => {
  let admin: AdminUser | undefined
  let customer: TestUser | undefined
  let seeded: Seeded | undefined

  test.beforeEach(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migrations 40–41 are not applied to this database')
    test.setTimeout(180_000)
    customer = (await createTestUser('refundee')) as TestUser
    seeded = await seedHeldRefund(customer.id)
    admin = (await createAdminTestUser('refunds')) as AdminUser
  })

  test.afterEach(async () => {
    if (customer) await deleteTestUser(customer.id)
    if (admin) await deleteTestUser(admin.user.id)
    customer = undefined
    admin = undefined
    seeded = undefined
  })

  test('approves a held refund once: a wrong code changes nothing, a double submit writes one row', async ({
    page,
  }) => {
    if (!admin || !seeded) throw new Error('not seeded')
    await signInAsAdmin(page, admin, `/admin/refunds/${seeded.refundId}`)
    const signedInAt = Date.now()

    await expect(
      page.getByRole('heading', { level: 1, name: `Refund for ${seeded.orderNumber}` }),
    ).toBeVisible()
    await expect(page.getByText('Held because: Over the', { exact: false })).toBeVisible()
    // Cancel is the owner's: an operator never sees it.
    await expect(page.getByRole('button', { name: 'Cancel refund' })).toHaveCount(0)
    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)

    await page.getByRole('button', { name: 'Approve refund' }).click()
    const dialog = page.getByRole('dialog', { name: 'Approve this refund?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(seeded.orderNumber, { exact: true })).toBeVisible()
    await expect(dialog.getByText('Over the', { exact: false })).toBeVisible()
    expect((await axe(page)).violations).toEqual([])

    // Refused first: a wrong code reaches no wrapper — nothing changes, nothing is written.
    await dialog.getByLabel('Reason').fill(REASON)
    await dialog.getByLabel('Code from your authenticator app').fill(wrongCode(admin.totpSecret))
    const confirm = dialog.getByRole('button', { name: /^Approve ₦[\d,.]+ refund$/ })
    await confirm.click()
    await expect(dialog.getByRole('alert')).toContainText(WRONG_CODE_WORDS)
    expect(await refundRow(seeded.refundId)).toMatchObject({ status: 'held', approved_by: null })
    expect(await approvals(seeded.refundId)).toEqual([])

    // Then the right code, pressed twice: one approval, one audit row.
    await dialog
      .getByLabel('Code from your authenticator app')
      .fill(await codeAfter(admin.totpSecret, signedInAt))
    await confirm.dblclick()
    await expect(dialog.getByRole('status')).toContainText('Approved', { timeout: 20_000 })

    await expect.poll(async () => (await refundRow(seeded?.refundId ?? '')).status).toBe('queued')
    expect(await refundRow(seeded.refundId)).toEqual({ status: 'queued', approved_by: admin.label })
    const rows = await approvals(seeded.refundId)
    expect(rows.filter((row) => row.outcome === 'ok')).toEqual([
      { outcome: 'ok', error_code: null, admin_label: admin.label, test_actor: true },
    ])
    expect(rows).toHaveLength(1)

    // The page is read again: the new status and its event are shown.
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByText('Queued', { exact: true }).first()).toBeVisible()
    await expect(page.getByText(`Approved · ${admin.label}`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approve refund' })).toHaveCount(0)
  })

  test('lists the held refund by status and order number, and shows the incidents page', async ({
    page,
  }) => {
    if (!admin || !seeded) throw new Error('not seeded')
    await signInAsAdmin(page, admin, '/admin/refunds')
    await page.goto('/admin/refunds?status=held')

    await expect(page.getByRole('heading', { level: 1, name: 'Refunds' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Test' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('link', { name: /^Refunds/ }).first()).toBeVisible()
    const status = page.getByRole('navigation', { name: 'Status' })
    await expect(status.getByRole('link', { name: /^Held for approval/ })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await expect(page.getByRole('link', { name: `Refund for ${seeded.orderNumber}` })).toBeVisible()
    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)

    // An order number is the only search; the URL never holds anything else.
    await page.goto(`/admin/refunds?q=${encodeURIComponent(seeded.orderNumber)}`)
    await page.getByRole('link', { name: `Refund for ${seeded.orderNumber}` }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/refunds/${seeded.refundId}$`))

    await page.goto('/admin/refunds/incidents')
    await expect(page.getByRole('heading', { level: 1, name: 'Payment incidents' })).toBeVisible()
    await expect(
      page
        .getByRole('navigation', { name: 'Refunds and payment incidents' })
        .getByRole('link', { name: /^Payment incidents/ }),
    ).toHaveAttribute('aria-current', 'page')
    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)

    // An id from nowhere: a plain empty state, with the way back.
    await page.goto('/admin/refunds/00000000-0000-4000-8000-000000000000')
    await expect(page.getByText('No refund with this id on the Test side')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to refunds' })).toBeVisible()
  })
})
