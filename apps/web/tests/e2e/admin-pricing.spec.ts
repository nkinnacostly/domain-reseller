import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import {
  createAdminTestUser,
  deleteTestUser,
  freshTotpCode,
  hasAdminSchema,
} from './support/accounts.mjs'
import { type AdminUser, expect, SIGN_IN_PROJECTS, signInAsAdmin, test } from './support/admin'

/**
 * /admin/pricing and /admin/pricing/fx (docs/ADMIN-SPEC.md §5.2 B12, §9), as a
 * test-only operator. No FX row is seeded — `fx_rates` has no test side, so a
 * seeded row would show on the live dashboard — so the FX page is checked
 * against whatever the table holds. VAT is read-only; Save, and Activate (or
 * Reject, when no held rate may be activated), are refused with the role's
 * words; and nothing changes: `pricing_settings` and every rate read the same
 * after as before, and no pricing action reached the audit log. No axe
 * violations and no sideways scroll on either page. One sign-in per
 * project: sign-ins are rate-limited per address.
 */

const ROLE_WORDS = "Your admin role can't do this. Ask the owner."
const VAT_WORDS = "VAT is a statutory rate; it's changed in the SQL editor."
const TOO_OLD = 'Too old to activate — the daily job will fetch a fresh one.'
const OWNER_ONLY_RATES = 'Only the owner can activate or reject a rate.'
const REASON = 'Checking the pricing pages as a test administrator'
const PRICING_ACTIONS = ['pricing.update', 'fx.activate', 'fx.reject']

const RATE = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const rate = (value: number | string) => `₦${RATE.format(Number(value))}`

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

/** Radix fades a dialog in; axe reads colours mid-fade, so wait for the dialog to settle first. */
async function dialogSettled(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target
      return (
        animation.playState !== 'running' ||
        !(target instanceof Element && target.closest('[data-slot^="dialog"]'))
      )
    }),
  )
}

async function overflowAt(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 })
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

/** Axe, then no sideways scroll at every width §5.3 names; back to the project's size after. */
async function accessibleEverywhere(page: Page) {
  const viewport = page.viewportSize()
  expect((await axe(page)).violations).toEqual([])
  for (const width of [320, 375, 768, 1024, 1440, 1920]) {
    expect(await overflowAt(page, width), `overflow at ${width}`).toBeLessThanOrEqual(1)
  }
  if (viewport) await page.setViewportSize(viewport)
}

/** The secret-key client, for reads only: this spec writes nothing to pricing. */
function service() {
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

type Rate = {
  id: string
  status: string
  costing_rate: number
  buffer_pct: number
  quoted_at: string
  effective_from: string | null
  reviewed_at: string | null
  reviewed_by: string | null
}

/** Everything a price is built from that this spec could touch: the settings row and every rate. */
async function pricingState() {
  const db = service()
  const [settings, rates] = await Promise.all([
    db
      .from('pricing_settings')
      .select(
        'margin_ngn, fx_buffer_pct, icann_fee_usd, fx_move_threshold_pct, vat_pct, updated_at, updated_by',
      )
      .single(),
    db
      .from('fx_rates')
      .select(
        'id, status, costing_rate, buffer_pct, quoted_at, effective_from, reviewed_at, reviewed_by',
      )
      .order('created_at'),
  ])
  if (settings.error) throw settings.error
  if (rates.error) throw rates.error
  return { settings: settings.data, rates: (rates.data ?? []) as Rate[] }
}

/** This admin's audit rows for any pricing action. */
async function pricingAudit(adminId: string) {
  const { data, error } = await service()
    .from('admin_audit_log')
    .select('id, action, outcome, error_code')
    .eq('admin_id', adminId)
    .in('action', PRICING_ACTIONS)
  if (error) throw error
  return data ?? []
}

/** Fills a money dialog's reason and code, confirms, and expects the role's words. */
async function refusedWithRoleWords(dialog: Locator, admin: AdminUser, confirm: string) {
  await dialog.getByLabel('Reason').fill(REASON)
  await dialog
    .getByLabel('Code from your authenticator app')
    .fill(await freshTotpCode(admin.totpSecret))
  await dialog.getByRole('button', { name: confirm, exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(ROLE_WORDS)
}

test.describe('the admin pricing pages', () => {
  let admin: AdminUser | undefined
  let before: Awaited<ReturnType<typeof pricingState>> | undefined

  test.beforeEach(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migrations 40–41 are not applied to this database')
    admin = (await createAdminTestUser('pricing')) as AdminUser
    before = await pricingState()
  })

  test.afterEach(async () => {
    if (admin) await deleteTestUser(admin.user.id)
    admin = undefined
    before = undefined
  })

  test('shows the inputs and whatever FX state exists, and refuses Save and Activate with the role’s words', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    if (!admin || !before) throw new Error('no admin')
    const settings = before.settings
    await signInAsAdmin(page, admin, '/admin/pricing')
    const main = page.getByRole('main')

    await test.step('the inputs, VAT read-only', async () => {
      await expect(main.getByRole('heading', { level: 1, name: 'Pricing' })).toBeVisible()
      const tabs = main.getByRole('navigation', { name: 'Pricing pages' })
      await expect(tabs.getByRole('link', { name: 'Pricing', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      )

      const stored = main.getByRole('region', { name: 'Settings', exact: true })
      await expect(
        stored.getByText(`₦${Number(settings.margin_ngn).toLocaleString('en-GB')} a domain`),
      ).toBeVisible()
      await expect(stored.getByText(`${Number(settings.vat_pct)}%`, { exact: true })).toBeVisible()
      await expect(stored.getByText(VAT_WORDS)).toBeVisible()
      // VAT is shown, never offered for editing.
      await expect(main.getByRole('textbox', { name: /VAT/ })).toHaveCount(0)
      const change = main.getByRole('region', { name: 'Change settings' })
      await expect(change.getByRole('textbox')).toHaveCount(4)
      await expect(change.getByText('Only the owner can save these settings.')).toBeVisible()

      // The worked example names a renewal beside the first year (N8), or says why there is none.
      const built = main.getByRole('region', { name: 'How a price is built' })
      await expect(
        built.getByText(
          /^\.com today: ₦[\d,]+ for the first (year|\d+ years), then ₦[\d,]+(\/yr| every \d+ years)\.$|^No example price|isn't on sale/,
        ),
      ).toBeVisible()

      await accessibleEverywhere(page)
    })

    await test.step('Save is refused with the role’s words', async () => {
      const change = main.getByRole('region', { name: 'Change settings' })
      const threshold = Number(settings.fx_move_threshold_pct)
      const field = change.getByRole('textbox', { name: /^Move threshold/ })
      await field.fill(String(threshold < 50 ? Math.floor(threshold) + 1 : 49))
      await expect(change.getByRole('status')).toHaveText('1 change ready to save.')
      await change.getByRole('button', { name: 'Save changes' }).click()
      const dialog = page.getByRole('dialog', { name: 'Change 1 pricing setting?' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText(/^\d+(\.\d+)?% → \d+(\.\d+)?%$/)).toBeVisible()
      await dialogSettled(page)
      expect((await axe(page)).violations).toEqual([])
      await refusedWithRoleWords(dialog, admin as AdminUser, 'Save settings')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
    })

    await test.step('the exchange rates, as the table holds them', async () => {
      await main
        .getByRole('navigation', { name: 'Pricing pages' })
        .getByRole('link', { name: 'Exchange rates' })
        .click()
      await expect(page).toHaveURL(/\/admin\/pricing\/fx$/)
      await expect(main.getByRole('heading', { level: 1, name: 'Exchange rates' })).toBeVisible()
      await expect(
        main
          .getByRole('navigation', { name: 'Pricing pages' })
          .getByRole('link', { name: 'Exchange rates' }),
      ).toHaveAttribute('aria-current', 'page')

      const rates = before?.rates ?? []
      const active = rates.find((row) => row.status === 'active') ?? null
      const held = rates.filter((row) => row.status === 'pending_review')

      const activePanel = main.getByRole('region', { name: 'Active rate' })
      await expect(
        active
          ? activePanel.getByText(`${rate(active.costing_rate)} to the dollar`, { exact: true })
          : activePanel.getByText('No active rate.', { exact: false }),
      ).toBeVisible()

      const heldPanel = main.getByRole('region', { name: `Held for review (${held.length})` })
      await expect(heldPanel).toBeVisible()
      const now = Date.now()
      let activatable: Rate | undefined
      for (const row of held) {
        const card = heldPanel.locator(`[data-rate-id="${row.id}"]`)
        await expect(
          card.getByRole('heading', { name: `${rate(row.costing_rate)} to the dollar` }),
        ).toBeVisible()
        const quoted = Date.parse(row.quoted_at)
        const blocked =
          quoted <= now - 48 * 3_600_000 ||
          (active !== null && quoted <= Date.parse(active.quoted_at))
        if (blocked) {
          await expect(card.getByText(TOO_OLD, { exact: false })).toBeVisible()
          await expect(card.getByRole('button', { name: /^Activate/ })).toHaveCount(0)
        } else {
          await expect(card.getByRole('button', { name: /^Activate/ })).toBeVisible()
          activatable ??= row
        }
        await expect(card.getByRole('button', { name: /^Reject/ })).toBeVisible()
      }
      if (held.length > 0) await expect(heldPanel.getByText(OWNER_ONLY_RATES)).toBeVisible()
      else await expect(heldPanel.getByText(/^No rate is held for review\./)).toBeVisible()

      await expect(main.getByRole('region', { name: 'Recent rates' })).toBeVisible()
      await accessibleEverywhere(page)

      // Activate where a held rate may be activated; otherwise Reject, refused just the same.
      if (activatable) {
        await heldPanel
          .locator(`[data-rate-id="${activatable.id}"]`)
          .getByRole('button', { name: /^Activate/ })
          .click()
        const dialog = page.getByRole('dialog', {
          name: /^Charge at ₦[\d,]+\.\d{2} to the dollar\?$/,
        })
        await expect(dialog).toBeVisible()
        await dialogSettled(page)
        expect((await axe(page)).violations).toEqual([])
        await refusedWithRoleWords(dialog, admin as AdminUser, 'Activate rate')
      } else if (held[0]) {
        await heldPanel
          .locator(`[data-rate-id="${held[0].id}"]`)
          .getByRole('button', { name: /^Reject/ })
          .click()
        const dialog = page.getByRole('dialog', { name: /^Reject the ₦[\d,]+\.\d{2} rate\?$/ })
        await expect(dialog).toBeVisible()
        await dialogSettled(page)
        expect((await axe(page)).violations).toEqual([])
        await refusedWithRoleWords(dialog, admin as AdminUser, 'Reject rate')
      }
    })

    await test.step('nothing changed', async () => {
      const after = await pricingState()
      expect(after.settings).toEqual(before?.settings)
      for (const row of before?.rates ?? []) {
        expect(
          after.rates.find((each) => each.id === row.id),
          row.id,
        ).toEqual(row)
      }
      // Refused in the web, before SQL: no pricing action reached the audit log.
      expect(await pricingAudit(admin?.user.id ?? '')).toEqual([])
    })
  })
})
