import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import type { BrowserContext, Locator, Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createAdminTestUser,
  createTestUser,
  deleteTestUser,
  hasAdminSchema,
} from './support/accounts.mjs'
import { type AdminUser, expect, SIGN_IN_PROJECTS, signInAsAdmin, test } from './support/admin'
import { seedTestFailedEmail } from './support/admin-seed.mjs'

/**
 * The emails page (docs/ADMIN-SPEC.md §5.2, §9 B11), as a test-only operator
 * on the Test side: recipients are masked and a provider's error shows only
 * with its addresses replaced; a failed email seeded with
 * `seed_test_failed_email` is sent again through the dialog and becomes
 * Waiting (`pending`), with one `email.requeue` audit row; once the same
 * email has been sent and bounced, "Send again" is not offered; and the
 * compliance tab offers nothing but filters. Every account is an
 * e2e-*@example.com user, and every row a test-mode row of one (D15).
 */

const MASKED = 'e•••@example.com'

type TestUser = { id: string; email: string; password: string }

/** The secret-key client: what was recorded, and the gateway's own steps for the bounce. */
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

async function emailState(id: string) {
  const { data, error } = await service()
    .from('email_outbox')
    .select('status, delivery_status, attempts, test_mode')
    .eq('id', id)
    .single()
  if (error) throw error
  return data
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

/**
 * Sends one waiting test email and records its bounce, as the gateway and
 * the provider would (`claim_emails`, `mark_email_sent`,
 * `record_email_delivery`). The claim takes the oldest due test email, so
 * it waits until that is this one — never taking another run's email.
 */
async function sendAndBounce(emailId: string) {
  const db = service()
  const worker = `e2e-b11-${randomUUID()}`
  for (let attempt = 0; attempt < 60; attempt++) {
    const { data: due, error } = await db
      .from('email_outbox')
      .select('id')
      .eq('test_mode', true)
      .eq('status', 'pending')
      .lte('next_attempt_at', new Date().toISOString())
      .order('next_attempt_at')
      .order('created_at')
      .limit(1)
    if (error) throw error
    if (due?.[0]?.id === emailId) {
      const claimed = await db.rpc('claim_emails', {
        p_worker: worker,
        p_test_mode: true,
        p_limit: 1,
      })
      if (claimed.error) throw claimed.error
      const ids = (claimed.data as { id: string }[]).map((row) => row.id)
      expect(ids, 'the claim took this email and no other').toEqual([emailId])
      const sent = await db.rpc('mark_email_sent', {
        p_id: emailId,
        p_worker: worker,
        p_message_id: `e2e-b11-${randomUUID()}`,
        p_template_version: 'e2e',
      })
      expect(sent.error).toBeNull()
      expect(sent.data).toBe(true)
      const bounced = await db.rpc('record_email_delivery', { p_id: emailId, p_status: 'bounced' })
      expect(bounced.error).toBeNull()
      expect(bounced.data).toBe(true)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('another test email stayed ahead of this one in the queue')
}

const shortId = (id: string) => id.replace(/-/g, '').slice(0, 8)

/** The one visible row (a card below xl, a table row from xl) for an email. */
function emailRow(page: Page, id: string): Locator {
  return page
    .locator('main li, main tr')
    .filter({ has: page.locator(`[data-email-id="${id}"]`) })
    .filter({ visible: true })
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

test.describe.configure({ mode: 'serial' })

test.describe('the emails page, as a test administrator', () => {
  let customer: TestUser | undefined
  let admin: AdminUser | undefined
  let emailId = ''
  let contexts: BrowserContext[] = []
  let page: Page

  test.beforeAll(async ({ browser }, info) => {
    test.skip(!SIGN_IN_PROJECTS.includes(info.project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migrations 40–41 are not applied to this database')
    test.setTimeout(180_000)
    customer = (await createTestUser('emails-customer')) as TestUser
    admin = (await createAdminTestUser('emails')) as AdminUser
    emailId = (await seedTestFailedEmail(customer.id)) as string
    // The runner gives a new context the project's device and base address.
    const context = await browser.newContext()
    contexts.push(context)
    page = await context.newPage()
    // signInAsAdmin matches the landing address as a pattern: a path, no query.
    await signInAsAdmin(page, admin, '/admin/emails')
  })

  test.afterAll(async () => {
    for (const context of contexts) await context.close()
    contexts = []
    // Deleting the account deletes its emails. A statement timeout on a busy
    // shared database gets one more try.
    for (const id of [customer?.id, admin?.user.id]) {
      if (id) await deleteTestUser(id).catch(() => deleteTestUser(id))
    }
    customer = undefined
    admin = undefined
  })

  test('the failed emails open from the overview’s link, the recipient masked', async () => {
    if (!customer) throw new Error('no customer')
    await page.goto('/admin/emails?status=failed')
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { level: 1, name: 'Emails' })).toBeVisible()
    await expect(
      main.getByRole('navigation', { name: 'Email views' }).getByRole('link', { name: 'Outbox' }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(
      main.getByRole('navigation', { name: 'Status' }).getByRole('link', { name: 'Failed' }),
    ).toHaveAttribute('aria-current', 'true')

    // The sidebar marks the page (S13); on a phone it is a drawer.
    const sidebar = page.getByRole('navigation', { name: 'Admin' }).filter({ visible: true })
    const menu = page.getByRole('button', { name: 'Open menu' }).filter({ visible: true })
    await expect(sidebar.or(menu).first()).toBeVisible()
    if ((await sidebar.count()) === 0) await menu.click()
    await expect(
      page
        .getByRole('navigation', { name: 'Admin' })
        .getByRole('link', { name: /^Emails/ })
        .filter({ visible: true })
        .first(),
    ).toHaveAttribute('aria-current', 'page')
    await page.goto('/admin/emails?status=failed')

    const row = emailRow(page, emailId)
    await expect(row).toHaveCount(1)
    await expect(row.getByText(MASKED, { exact: true })).toBeVisible()
    await expect(row.getByText('Failed', { exact: true })).toBeVisible()
    // The seeded error names the address; only the masked copy reaches the page.
    await expect(row.getByText('e2e: a seeded failure for [address]')).toBeVisible()
    expect(await page.content()).not.toContain(customer.email)
    // Every recipient on the page is masked.
    const text = await main.innerText()
    expect(text).not.toMatch(/\be2e-[a-z0-9-]+@example\.com/i)
  })

  test('"Send again" puts a failed email back in the queue, with one audit row', async () => {
    if (!admin) throw new Error('no admin')
    await page.goto('/admin/emails?status=failed')
    const row = emailRow(page, emailId)
    await row
      .getByRole('button', { name: `Send again the Order receipt email ${shortId(emailId)}` })
      .click()

    const dialog = page.getByRole('dialog', { name: 'Send this email again?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(MASKED, { exact: true })).toBeVisible()
    await expect(dialog.getByText('3 tries')).toBeVisible()
    // A standard action: a reason may be given, and no code is asked for.
    await expect(dialog.getByLabel('Code from your authenticator app')).toHaveCount(0)
    await dialog.getByLabel('Reason (optional)').fill('e2e: the provider was down')
    await dialog.getByRole('button', { name: 'Send again', exact: true }).click()

    // The list re-reads: the email is no longer failed.
    await expect(emailRow(page, emailId)).toHaveCount(0)
    expect(await emailState(emailId)).toMatchObject({
      status: 'pending',
      attempts: 0,
      test_mode: true,
    })

    await page.goto('/admin/emails?status=pending')
    const waiting = emailRow(page, emailId)
    await expect(waiting.getByText('Waiting', { exact: true })).toBeVisible()
    await expect(waiting.getByRole('button', { name: /Send again/ })).toHaveCount(0)

    const rows = await auditRows(admin.user.id, 'email.requeue')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'ok', target_id: emailId, test_actor: true })
    expect(rows[0]?.detail).toMatchObject({
      kind: 'order_receipt',
      before: { status: 'failed' },
      after: { status: 'pending' },
    })
  })

  test('once the email has bounced, "Send again" is not offered', async () => {
    await sendAndBounce(emailId)
    expect(await emailState(emailId)).toMatchObject({ status: 'sent', delivery_status: 'bounced' })

    await page.goto('/admin/emails?status=bounced')
    const row = emailRow(page, emailId)
    await expect(row.getByText('Bounced', { exact: true })).toBeVisible()
    await expect(row.getByText(MASKED, { exact: true })).toBeVisible()
    await expect(row.getByRole('button', { name: /Send again/ })).toHaveCount(0)
    await expect(page.getByRole('main').getByRole('button', { name: /Send again/ })).toHaveCount(0)
  })

  test('the compliance tab only reads: no action, nothing but filters', async () => {
    await page.goto('/admin/emails?tab=compliance')
    const main = page.getByRole('main')
    await expect(
      main
        .getByRole('navigation', { name: 'Email views' })
        .getByRole('link', { name: 'Compliance notices' }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(main.getByTestId('emails-compliance-note')).toContainText(
      'Nothing on this page changes, deletes or sends them.',
    )
    const list = main.getByRole('region', { name: /^(\d[\d,]* notices?|Notices)$/ })
    await expect(list).toBeVisible()
    await expect(list.getByRole('button')).toHaveCount(0)
    await expect(list.locator('form')).toHaveCount(0)
    await expect(main.getByRole('button', { name: /Send again|Delete|Resend|Edit/ })).toHaveCount(0)
    // The filters are links and one dates form, sent with GET: nothing here writes.
    const filters = main.getByRole('region', { name: 'Find notices' })
    const methods = await filters
      .locator('form')
      .evaluateAll((forms) => forms.map((form) => form.getAttribute('method')))
    expect(methods).toEqual(['get'])
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
        await expect(page.getByRole('heading', { level: 1, name: 'Emails' })).toBeVisible()
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

  test('the outbox passes axe in both themes, at every width, with no horizontal overflow', async () => {
    test.slow()
    await accessible('/admin/emails')
  })

  test('the compliance tab passes axe in both themes, at every width, with no overflow', async () => {
    test.slow()
    await accessible('/admin/emails?tab=compliance')
  })
})
