import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import {
  createAdminTestUser,
  deleteTestUser,
  hasAdminSchema,
  purgeTestLedgerEntries,
} from './support/accounts.mjs'
import { type AdminUser, expect, SIGN_IN_PROJECTS, signInAsAdmin, test } from './support/admin'
import { seedTestLedgerEntries } from './support/admin-seed.mjs'

/**
 * /admin/supplier and its pages (docs/ADMIN-SPEC.md §5.2 B6, §9), against the
 * mock gateway, as a test-only operator — so the Test side: the balance
 * tiles, "Read live balance" with the mock's $43.38 and exactly one
 * `supplier.balance` intent row; the ledger's `e2e-` mirror rows, its
 * filters (`?status=unexplained` from the overview, `?trace=` from an
 * alert) and a live search sent as a POST; the calls; the lookups; and the
 * price list and price check refused in SQL's test-administrator words. No
 * axe violations and no sideways scroll on any page. One sign-in per
 * project: sign-ins are rate-limited per address.
 */

const SUPPLIER_PROJECTS = [...SIGN_IN_PROJECTS, 'mobile-android']

const TEST_ADMIN_WORDS = "Test administrators can't do this on live records."
const TOPUPS_LIVE_ONLY =
  "Top-up costs are recorded on the live side only: the test side's credits are the sandbox's, not money we paid."

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

/** Axe, then no sideways scroll at every width §5.3 names; back to the project's size after. */
async function accessibleEverywhere(page: Page) {
  const viewport = page.viewportSize()
  const results = await axe(page)
  expect(results.violations).toEqual([])
  for (const width of [320, 375, 768, 1024, 1440, 1920]) {
    expect(await overflowAt(page, width), `overflow at ${width}`).toBeLessThanOrEqual(1)
  }
  if (viewport) await page.setViewportSize(viewport)
}

/** Reads only: this admin's audit rows for one action, with the secret key. */
async function auditRows(adminId: string, action: string) {
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
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client
    .from('admin_audit_log')
    .select('id, outcome, side, target_id')
    .eq('admin_id', adminId)
    .eq('action', action)
  if (error) throw error
  return data ?? []
}

test.describe('the admin supplier pages', () => {
  let admin: AdminUser | undefined
  let seeded: { traceIds: string[]; debit: string; credit: string } | undefined

  test.beforeEach(async () => {
    test.skip(!SUPPLIER_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migration 40 is not applied to this database')
    admin = (await createAdminTestUser('supplier')) as AdminUser
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const debit = `e2e-supplier-debit-${tag}.com`
    const credit = `e2e-supplier-credit-${tag}`
    const { traceIds } = await seedTestLedgerEntries([
      { description: debit, deltaCents: -1131, balanceBeforeCents: 50_000 },
      { description: credit, deltaCents: 3600, balanceBeforeCents: 48_869 },
    ])
    seeded = { traceIds, debit, credit }
  })
  test.afterEach(async () => {
    if (admin) await deleteTestUser(admin.user.id)
    admin = undefined
    // The purge takes every e2e ledger row on the test side; another run's too,
    // so it is left to the global teardown when runs share the database.
    if (seeded && process.env.E2E_KEEP_OTHERS !== '1') await purgeTestLedgerEntries()
    seeded = undefined
  })

  test('balance, ledger, calls, lookups and the price list, on the Test side', async ({ page }) => {
    test.setTimeout(240_000)
    if (!admin || !seeded) throw new Error('no admin')
    const { user } = admin
    const { traceIds, debit, credit } = seeded
    await signInAsAdmin(page, admin, '/admin/supplier')
    const main = page.getByRole('main')

    await test.step('the balance', async () => {
      await expect(main.getByRole('heading', { level: 1, name: 'Supplier' })).toBeVisible()
      await expect(main.getByRole('button', { name: 'Test' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      const tabs = main.getByRole('navigation', { name: 'Supplier pages' })
      await expect(tabs.getByRole('link', { name: 'Balance' })).toHaveAttribute(
        'aria-current',
        'page',
      )

      const balance = main.getByRole('region', { name: 'Balance', exact: true })
      for (const key of ['snapshot', 'committed', 'burn7', 'burn30', 'runway', 'target', 'alert']) {
        await expect(balance.locator(`[data-tile="${key}"]`), key).toBeVisible()
      }
      await expect(balance.locator('[data-tile="unexplained"] a')).toHaveAttribute(
        'href',
        '/admin/supplier/ledger?status=unexplained',
      )

      // One press, one audited read, through the mock gateway's $43.38.
      expect(await auditRows(user.id, 'supplier.balance')).toHaveLength(0)
      await balance.getByRole('button', { name: 'Read live balance' }).click()
      await expect(balance.locator('[data-live-balance]')).toHaveText(
        /^\$43\.38 at (\d{1,2} \w{3} \d{4}, )?12:05 WAT on test \(/,
      )
      const notes = await auditRows(user.id, 'supplier.balance')
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatchObject({ outcome: 'intent', side: 'test', target_id: 'test' })

      // Top-up costs are the live side's: the test side says so and offers nothing.
      const topups = main.getByRole('region', { name: 'Top-ups', exact: true })
      await expect(topups.getByText(TOPUPS_LIVE_ONLY)).toBeVisible()
      await expect(topups.getByText('Record what it cost')).toHaveCount(0)

      // Charts, when there is anything to draw, are named pictures with their figures.
      for (const svg of await main.locator('svg[role="img"]').all()) {
        await expect(svg).toHaveAttribute('aria-label', /\. The figures follow in a table\.$/)
      }
      await accessibleEverywhere(page)
    })

    await test.step('the ledger: the overview link, the e2e mirror rows, one trace', async () => {
      await page.goto('/admin/supplier/ledger?status=unexplained')
      await expect(main.getByRole('heading', { level: 1, name: 'Supplier ledger' })).toBeVisible()
      const match = main.getByRole('navigation', { name: 'Match' })
      await expect(match.getByRole('link', { name: 'No matching order' })).toHaveAttribute(
        'aria-current',
        'true',
      )
      await expect(main.getByRole('region', { name: 'Balance chain', exact: true })).toBeVisible()

      // Both seeded rows: shapes the mirror does not classify, kept and shown raw.
      await page.goto('/admin/supplier/ledger?status=unclassified&per=100')
      const entries = main.getByRole('region', { name: 'Entries', exact: true })
      await expect(entries.getByText(debit).filter({ visible: true }).first()).toBeVisible()
      await expect(entries.getByText(credit).filter({ visible: true }).first()).toBeVisible()
      await expect(entries.getByText('−$11.31').filter({ visible: true }).first()).toBeVisible()
      await expect(entries.getByText('+$36.00').filter({ visible: true }).first()).toBeVisible()

      // An alert's link: one entry, by its trace id.
      await page.goto(`/admin/supplier/ledger?trace=${traceIds[0]}`)
      await expect(entries.getByText(debit).filter({ visible: true }).first()).toBeVisible()
      await expect(entries.getByText(credit)).toHaveCount(0)
      await expect(entries.getByRole('link', { name: 'Show every entry' })).toHaveAttribute(
        'href',
        '/admin/supplier/ledger',
      )
      await accessibleEverywhere(page)
    })

    await test.step('the live ledger search is a POST: nothing searched goes in the address', async () => {
      await page.goto('/admin/supplier/ledger')
      const search = main.getByRole('form', { name: 'Search the live ledger' })
      // Hydrated first: a press before the script runs sends nothing, by design.
      await expect(search).toHaveAttribute('data-ready', 'true')
      await search.getByLabel('Description contains').fill(debit)
      const before = page.url()
      const [request] = await Promise.all([
        page.waitForRequest(
          (req) =>
            req.method() === 'POST' && new URL(req.url()).pathname === '/admin/supplier/ledger',
        ),
        search.getByRole('button', { name: 'Search the live ledger' }).click(),
      ])
      expect(request.postData() ?? '').toContain(debit)
      const results = main.getByRole('region', { name: 'Live ledger results', exact: true })
      await expect(results).toContainText('DomainNameAPI lists no entries for this search.')
      expect(page.url()).toBe(before)
      expect(page.url()).not.toContain('supplier-debit')
      const searches = await auditRows(user.id, 'supplier.ledger_live')
      expect(searches.filter((row) => row.outcome === 'intent')).toHaveLength(1)
    })

    await test.step('the calls', async () => {
      await page.goto('/admin/supplier/calls')
      await expect(main.getByRole('heading', { level: 1, name: 'Supplier calls' })).toBeVisible()
      await expect(main.getByRole('region', { name: 'By operation', exact: true })).toBeVisible()
      await expect(main.getByRole('region', { name: 'Calls', exact: true })).toBeVisible()
      await accessibleEverywhere(page)
    })

    await test.step('the lookups: a domain from the mock, and no price check for a test admin', async () => {
      await page.goto('/admin/supplier/lookup')
      await expect(main.getByRole('heading', { level: 1, name: 'Registry lookup' })).toBeVisible()
      const domain = main.getByRole('region', { name: 'A domain at the registry', exact: true })
      await expect(domain.locator('[data-ready="true"]')).toHaveCount(1)
      await domain.getByLabel('Domain name').fill('e2e-lookup.com')
      await domain.getByRole('button', { name: 'Read the transfer state' }).click()
      await expect(domain.getByRole('status')).toContainText(
        'Refused by the registry or the losing registrar',
      )
      await domain.getByRole('button', { name: 'Read the registry now' }).click()
      await expect(domain.getByRole('status')).toContainText(
        'Not in our DomainNameAPI account on this side',
      )
      expect(page.url()).not.toContain('e2e-lookup')

      const price = main.getByRole('region', { name: 'A price', exact: true })
      await expect(price.getByText(TEST_ADMIN_WORDS)).toBeVisible()
      await expect(price.getByRole('button', { name: 'Check the price' })).toHaveCount(0)
      await accessibleEverywhere(page)
    })

    await test.step('the price list: preview and apply refused in the test-admin words', async () => {
      await page.goto('/admin/supplier/catalogue')
      await expect(main.getByRole('heading', { level: 1, name: 'Price list' })).toBeVisible()
      for (const name of ['Domain extensions', 'SSL products']) {
        const panel = main.getByRole('region', { name, exact: true })
        await expect(panel.getByText(TEST_ADMIN_WORDS)).toBeVisible()
        await expect(panel.getByRole('button', { name: 'Preview changes' })).toHaveCount(0)
        await expect(panel.getByRole('button', { name: /^Apply / })).toHaveCount(0)
        await expect(panel).toContainText('not shown to test administrators')
      }
      await expect(
        main.getByRole('navigation', { name: 'Supplier pages' }).getByRole('link', {
          name: 'Price list',
        }),
      ).toHaveAttribute('aria-current', 'page')
      await accessibleEverywhere(page)
    })
  })
})
