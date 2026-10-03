import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createAdminTestUser, deleteTestUser, hasAdminSchema } from './support/accounts.mjs'
import {
  type AdminUser,
  codeAfter,
  expect,
  SIGN_IN_PROJECTS,
  signInAsAdmin,
  test,
} from './support/admin'
import { adminSqlSession } from './support/admin-seed.mjs'

/**
 * /admin/audit (docs/ADMIN-SPEC.md §5.2, §9 B14), as a test-only operator on
 * the Test side. The spec makes its own entries first: a side switch, which
 * records nothing; "Read live balance" against the mock gateway, which writes
 * one `supplier.balance` intent note (the mock claims no note, so no result is
 * recorded); and a customer search by the admin's own e2e address, which
 * writes one `customer.search` row naming the account matched — never the
 * address. Then the log shows both, filters them by action family and by
 * outcome, expands an entry's `detail` without a word of personal data, and
 * offers nothing that edits or deletes; "Redact reason", the owner's, is
 * refused by SQL when this admin asks for it directly, and never offered. No axe violations and no sideways
 * scroll. One sign-in per project: sign-ins are rate-limited per address.
 */

/** The secret-key client, to read back what the audit log recorded. */
function service(): SupabaseClient {
  const path = fileURLToPath(new URL('../../../../.env', import.meta.url))
  const env: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key) env[key] = rest.join('=').replace(/^["']|["']$/g, '')
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

type AuditRow = {
  id: number
  action: string
  outcome: string
  side: string | null
  detail: unknown
}

/** Reads only: every audit row this admin has written, oldest first. */
async function auditRows(adminId: string): Promise<AuditRow[]> {
  const { data, error } = await service()
    .from('admin_audit_log')
    .select('id, action, outcome, side, detail')
    .eq('admin_id', adminId)
    .order('id', { ascending: true })
  if (error) throw error
  return (data ?? []) as AuditRow[]
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

/**
 * Axe in both themes (S3, S8) — after `ready`, which opens what the check
 * should see — then no sideways scroll at every width §5.3 names: the table
 * at desktop widths, the cards below. Back to light and the project's size.
 */
async function accessibleEverywhere(page: Page, ready: () => Promise<void> = async () => {}) {
  const viewport = page.viewportSize()
  try {
    for (const theme of ['light', 'dark'] as const) {
      // The site starts light; a chosen theme is what next-themes keeps.
      await page.evaluate((value) => localStorage.setItem('theme', value), theme)
      await page.reload()
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await ready()
      const results = await axe(page)
      expect(results.violations, theme).toEqual([])
    }
    for (const width of [320, 375, 768, 1024, 1440, 1920]) {
      expect(await overflowAt(page, width), `overflow at ${width}`).toBeLessThanOrEqual(1)
    }
  } finally {
    await page.evaluate(() => localStorage.setItem('theme', 'light'))
    if (viewport) await page.setViewportSize(viewport)
  }
}

/** The entry's link, in whichever layout (cards or table) this screen shows. */
const entryLink = (main: Locator, id: number) =>
  main.getByRole('link', { name: `Entry #${id}`, exact: true }).filter({ visible: true })

/** The card or table row an entry sits in, in whichever layout this screen shows. */
const entryOf = (main: Locator, id: number) =>
  main
    .locator('li, tr')
    .filter({ has: main.page().getByRole('link', { name: `Entry #${id}`, exact: true }) })
    .filter({ visible: true })

test.describe('the audit log', () => {
  let admin: AdminUser | undefined

  test.beforeEach(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migration 40 is not applied to this database')
    admin = (await createAdminTestUser('audit')) as AdminUser
  })

  test.afterEach(async () => {
    // A statement timeout on a busy shared database gets one more try.
    const id = admin?.user.id
    if (id) await deleteTestUser(id).catch(() => deleteTestUser(id))
    admin = undefined
  })

  test('shows what this admin did, filters it, expands it, and edits nothing', async ({ page }) => {
    test.setTimeout(240_000)
    if (!admin) throw new Error('no admin')
    const { user, label, totpSecret } = admin
    await signInAsAdmin(page, admin, '/admin/supplier')
    const signedInAt = Date.now()
    const main = page.getByRole('main')

    await test.step('a side switch records nothing', async () => {
      expect(await auditRows(user.id)).toEqual([])
      const sides = main.getByRole('group', { name: 'Records shown' })
      const live = sides.getByRole('button', { name: 'Live' })
      const testSide = sides.getByRole('button', { name: 'Test' })
      await expect(testSide).toHaveAttribute('aria-pressed', 'true')
      // A test administrator's Live button is disabled, and SQL keeps them on
      // Test whatever the cookie says (D15). Send the switch the button sends,
      // all the same: the side stays Test, and nothing is audited.
      await expect(live).toBeDisabled()
      await live.evaluate((button) => button.removeAttribute('disabled'))
      const answer = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.request().headers()['next-action'] !== undefined,
      )
      await live.click()
      expect((await answer).status()).toBe(200)
      await expect(testSide).toHaveAttribute('aria-pressed', 'true')
      expect(await auditRows(user.id)).toEqual([])
    })

    let balanceId = 0
    await test.step('a live read writes one intent note', async () => {
      const balance = main.getByRole('region', { name: 'Balance', exact: true })
      await balance.getByRole('button', { name: 'Read live balance' }).click()
      await expect(balance.locator('[data-live-balance]')).toContainText('$43.38')
      const rows = await auditRows(user.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ action: 'supplier.balance', outcome: 'intent', side: 'test' })
      balanceId = rows[0]?.id ?? 0
    })

    let searchId = 0
    await test.step('a customer search writes one row, naming the account, never the address', async () => {
      await page.goto('/admin/customers')
      const form = page.locator('form[data-enhanced="true"]')
      await expect(form).toBeVisible()
      await form.getByRole('searchbox', { name: 'Email, order number or domain' }).fill(user.email)
      await form.getByRole('button', { name: 'Search', exact: true }).click()
      await expect(page.getByText(/^1 customer matches exactly\.$/)).toBeVisible()
      const rows = await auditRows(user.id)
      expect(rows).toHaveLength(2)
      expect(rows[1]).toMatchObject({
        action: 'customer.search',
        outcome: 'ok',
        detail: { kind: 'email', matched: [user.id] },
      })
      expect(JSON.stringify(rows)).not.toContain(user.email)
      searchId = rows[1]?.id ?? 0
    })

    await test.step('the log shows both, newest first, and marks the page', async () => {
      await page.goto(`/admin/audit?admin=${label}`)
      await expect(main.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible()
      await expect(page.getByTestId('audit-scope-note')).toHaveText(
        "Test administrators see test administrators' entries only.",
      )
      await expect(entryLink(main, searchId)).toBeVisible()
      await expect(entryLink(main, balanceId)).toBeVisible()
      // Newest first: the search comes before the read.
      const order = await main
        .getByRole('link', { name: /^Entry #\d+$/ })
        .filter({ visible: true })
        .allTextContents()
      expect(order).toEqual([`Entry #${searchId}`, `Entry #${balanceId}`])

      const read = entryOf(main, balanceId)
      await expect(read).toContainText('Read the live balance')
      await expect(read).toContainText('supplier.balance')
      await expect(read).toContainText('Supplier · test')
      await expect(read).toContainText('Asked')
      // The mock gateway claims no note, so nothing answers it.
      await expect(read.locator('[data-gateway-result]')).toHaveText('No result recorded')
      const search = entryOf(main, searchId)
      await expect(search).toContainText('Look up a customer')
      await expect(search).toContainText('Customer search')
      await expect(search).toContainText('Done')
      await expect(search).toContainText(label)
      expect(await main.innerText()).not.toContain(user.email)

      // The sidebar marks the page (S13); on a phone it is a drawer.
      const sidebar = page.getByRole('navigation', { name: 'Admin' }).filter({ visible: true })
      const menu = page.getByRole('button', { name: 'Open menu' }).filter({ visible: true })
      await expect(sidebar.or(menu).first()).toBeVisible()
      if ((await sidebar.count()) === 0) await menu.click()
      await expect(
        page
          .getByRole('navigation', { name: 'Admin' })
          .getByRole('link', { name: /^Audit log/ })
          .filter({ visible: true })
          .first(),
      ).toHaveAttribute('aria-current', 'page')
      await page.goto(`/admin/audit?admin=${label}`)
      await accessibleEverywhere(page)
    })

    await test.step('filters by action family and by outcome', async () => {
      const action = main.getByRole('navigation', { name: 'Action' })
      await action.getByRole('link', { name: 'Supplier', exact: true }).click()
      await expect(page).toHaveURL(/[?&]action=supplier(&|$)/)
      await expect(entryLink(main, balanceId)).toBeVisible()
      await expect(entryLink(main, searchId)).toHaveCount(0)
      await expect(action.getByRole('link', { name: 'Supplier', exact: true })).toHaveAttribute(
        'aria-current',
        'true',
      )

      await action.getByRole('link', { name: 'Customers', exact: true }).click()
      await expect(page).toHaveURL(/[?&]action=customer(&|$)/)
      await expect(entryLink(main, searchId)).toBeVisible()
      await expect(entryLink(main, balanceId)).toHaveCount(0)

      await page.goto(`/admin/audit?admin=${label}`)
      const result = main.getByRole('navigation', { name: 'Result' })
      await result.getByRole('link', { name: 'Asked', exact: true }).click()
      await expect(page).toHaveURL(/[?&]outcome=intent(&|$)/)
      await expect(entryLink(main, balanceId)).toBeVisible()
      await expect(entryLink(main, searchId)).toHaveCount(0)

      await page.goto(`/admin/audit?admin=${label}&outcome=refused`)
      await expect(main.getByText('No entries match these filters.')).toBeVisible()
      await expect(main.getByRole('link', { name: 'Clear the filters' })).toHaveAttribute(
        'href',
        '/admin/audit',
      )
    })

    await test.step('an entry’s detail expands, with no personal data in it', async () => {
      await page.goto(`/admin/audit?id=${searchId}`)
      await expect(main.getByText(`Entry #${searchId} only.`)).toBeVisible()
      await expect(entryLink(main, balanceId)).toHaveCount(0)
      const details = main.locator(`details[data-entry-details="${searchId}"]`).filter({
        visible: true,
      })
      const summary = details.locator('summary')
      const open = async () => {
        await expect(details).not.toHaveAttribute('open')
        await expect(summary).toHaveAccessibleName(`Show details of entry #${searchId}`)
        await summary.click()
        await expect(details).toHaveAttribute('open', '')
        await expect(summary).toHaveAccessibleName(`Hide details of entry #${searchId}`)
      }
      await open()
      await expect(details.locator('[data-detail-line="kind"]')).toContainText('email')
      await expect(details.locator('[data-detail-line="matched"]')).toContainText(user.id)
      await expect(details).toContainText('Customer search')
      // The admin's own address is in the sidebar's account menu, never in the log.
      expect(await main.innerHTML()).not.toContain(user.email)
      await accessibleEverywhere(page, open)
    })

    await test.step('nothing on the page edits, deletes or redacts an entry', async () => {
      await page.goto(`/admin/audit?admin=${label}`)
      await expect(entryLink(main, searchId)).toBeVisible()
      await expect(main.getByRole('button', { name: /redact|edit|delete|remove/i })).toHaveCount(0)
      expect(await main.getByRole('button').allTextContents()).toEqual(['Show'])
      const methods = await main
        .locator('form')
        .evaluateAll((forms) => forms.map((form) => (form as HTMLFormElement).method))
      expect(methods).toEqual(['get'])
      expect(await auditRows(user.id)).toHaveLength(2)
    })

    await test.step('"Redact reason" is the owner’s: SQL refuses a test administrator, and the page offers none', async () => {
      // Asked directly, as this admin at aal2: refused, recorded, and nothing removed.
      const db = await adminSqlSession({ user }, await codeAfter(totpSecret, signedInAt))
      const why = 'e2e: a test administrator may not redact'
      const { data, error } = await db.rpc('admin_redact_reason', {
        p_audit_id: searchId,
        p_why: why,
        p_request_key: randomUUID(),
      })
      await db.auth.signOut({ scope: 'local' })
      expect(error).toBeNull()
      expect(data).toMatchObject({ ok: false, code: 'TEST_ADMIN' })
      const rows = await auditRows(user.id)
      expect(rows).toHaveLength(3)
      const refusal = rows[2]
      expect(refusal).toMatchObject({ action: 'audit.redact', outcome: 'refused', detail: {} })

      // The refusal carries a typed reason — an owner would be offered "Redact reason" on it.
      await page.goto(`/admin/audit?admin=${label}`)
      const entry = entryOf(main, refusal?.id ?? 0)
      await expect(entry).toContainText(why)
      await expect(entry).toContainText('Refused')
      await expect(main.getByRole('button', { name: /^Redact reason/ })).toHaveCount(0)
    })
  })
})
