import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createAdminTestUser,
  createSandboxDomain,
  deleteTestUser,
  freshTotpCode,
  hasAdminSchema,
  updateTestDomain,
} from './support/accounts.mjs'
import { type AdminUser, expect, SIGN_IN_PROJECTS, signInAsAdmin, test } from './support/admin'

/**
 * /admin/settings and its pages (docs/ADMIN-SPEC.md §5.2 B13, §9), as a
 * test-only operator — so the Test side: the limits are not shown; the
 * extensions list filters by name and state and shows the domains held on
 * each; the pause dialog will not send until the extension's name is typed
 * back, and the change is refused, so nothing is paused; the presets list
 * shows who uses each preset and its open draft (`?status=draft`, the
 * overview's link); and the admins page lists only this admin's own row,
 * with its linked device. Nothing on the hosted project is changed: every
 * dialog here is refused. No axe violations and no sideways scroll.
 */

const ROLE_WORDS = "Your admin role can't do this. Ask the owner."
const LIMITS_HIDDEN = 'Limits are not shown to test administrators.'

/** A low-traffic extension for the refused pause: even refused, never .com. */
const PAUSE_TARGET = 'abogado'

/** The secret-key client: seeds this run's test rows and reads back what is stored. */
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

/** A host's preset that is checked in DNS: not a registrar default, not per-domain. */
async function checkedPreset(): Promise<{ id: string; provider: string }> {
  const { data, error } = await service()
    .from('nameserver_presets')
    .select('id, provider')
    .is('registrar_default_for', null)
    .eq('assigns_per_zone', false)
    .order('provider')
    .limit(1)
    .single()
  if (error) throw error
  return data
}

async function isPaused(name: string): Promise<boolean> {
  const { data, error } = await service().from('tlds').select('is_paused').eq('name', name).single()
  if (error) throw error
  return data.is_paused
}

test.describe('the admin settings pages', () => {
  let admin: AdminUser | undefined

  test.beforeEach(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migration 40 is not applied to this database')
    admin = (await createAdminTestUser('settings')) as AdminUser
  })
  test.afterEach(async () => {
    if (admin) await deleteTestUser(admin.user.id)
    admin = undefined
  })

  test('limits, extensions, presets and admins, on the Test side', async ({ page }) => {
    test.setTimeout(240_000)
    if (!admin) throw new Error('no admin')
    const { user, label, totpSecret } = admin
    // One held test domain on .com, on a checked host's preset: the counts have something to show.
    const preset = await checkedPreset()
    const domain = await createSandboxDomain(user.id)
    await updateTestDomain(domain.id, { nameserver_preset_id: preset.id })
    expect(await isPaused(PAUSE_TARGET)).toBe(false)

    await signInAsAdmin(page, admin, '/admin/settings')
    const main = page.getByRole('main')
    const tabs = main.getByRole('navigation', { name: 'Settings pages' })

    await test.step('the limits: not shown to a test administrator', async () => {
      await expect(main.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
      await expect(main.getByRole('button', { name: 'Test' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(tabs.getByRole('link', { name: 'Limits' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      // The sidebar marks Settings as where you are (on a phone it sits in the closed drawer).
      await expect(
        page
          .getByRole('navigation', { name: 'Admin', includeHidden: true })
          .getByRole('link', { name: /^Settings/, includeHidden: true })
          .first(),
      ).toHaveAttribute('aria-current', 'page')
      const limits = main.getByRole('region', { name: 'Limits', exact: true })
      await expect(limits.getByText(LIMITS_HIDDEN)).toBeVisible()
      await expect(limits.getByRole('form', { name: 'Limits' })).toHaveCount(0)
      await accessibleEverywhere(page)
    })

    await test.step('extensions: filtered by name and state, with held counts', async () => {
      await tabs.getByRole('link', { name: 'Extensions' }).click()
      await expect(main.getByRole('heading', { level: 1, name: 'Extensions' })).toBeVisible()
      await expect(tabs.getByRole('link', { name: 'Extensions' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      const find = main.getByRole('search').getByRole('form', { name: 'Extensions by name' })
      await find.getByLabel('Name starts with').fill('com')
      await find.getByRole('button', { name: 'Find' }).click()
      await expect(page).toHaveURL(/\/admin\/settings\/extensions\?q=com$/)
      const list = main.getByRole('region', { name: /^Matching extensions · \d+$/ })
      await expect(list).toBeVisible()
      const held = list.locator('[data-held="com"]').filter({ visible: true }).first()
      await expect(held).toHaveText(/^[\d,]+$/)
      expect(Number((await held.textContent())?.replace(/,/g, ''))).toBeGreaterThanOrEqual(1)

      const states = main.getByRole('navigation', { name: 'Extension state' })
      await states.getByRole('link', { name: 'Paused' }).click()
      await expect(page).toHaveURL(/status=paused/)
      await expect(page).toHaveURL(/q=com/)
      await expect(states.getByRole('link', { name: 'Paused' })).toHaveAttribute(
        'aria-current',
        'true',
      )
      // The .com family's paused extensions, each saying so in words.
      await expect(list.getByText('.com.ng').filter({ visible: true }).first()).toBeVisible()
      await expect(list.getByText('.com', { exact: true })).toHaveCount(0)
      // Straight after the click: a chosen chip's colours change at once, never fade in.
      await accessibleEverywhere(page)
    })

    await test.step('the pause dialog wants the name typed back, and a test admin is refused', async () => {
      await page.goto(`/admin/settings/extensions?q=${PAUSE_TARGET}`)
      await main
        .getByRole('link', { name: `Change .${PAUSE_TARGET}` })
        .filter({ visible: true })
        .first()
        .click()
      const panel = main.getByRole('region', { name: `Change .${PAUSE_TARGET}` })
      await expect(panel).toBeVisible()
      await expect(panel).toContainText('Only the owner pauses, resumes or features an extension.')
      await expect(panel).toContainText(/Held domains \(Test side\)/)
      await accessibleEverywhere(page)

      await panel.getByRole('button', { name: `Pause .${PAUSE_TARGET}` }).click()
      const dialog = page.getByRole('dialog', { name: `Pause .${PAUSE_TARGET}?` })
      await expect(dialog).toBeVisible()
      // A destructive dialog opens on Cancel.
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
      const pause = dialog.getByRole('button', { name: 'Pause', exact: true })
      await dialog.getByLabel('Why it is paused').fill('e2e: checking the pause dialog only')
      await dialog
        .getByLabel('Code from your authenticator app')
        .fill(await freshTotpCode(totpSecret))
      // Everything but the name typed back: the button stays off.
      await expect(pause).toBeDisabled()
      await dialog.getByLabel(`Type .${PAUSE_TARGET} to confirm`).fill(`.${PAUSE_TARGET}x`)
      await expect(pause).toBeDisabled()
      await dialog.getByLabel(`Type .${PAUSE_TARGET} to confirm`).fill(`.${PAUSE_TARGET}`)
      await expect(pause).toBeEnabled()
      await pause.click()
      await expect(dialog.getByText(ROLE_WORDS)).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      expect(await isPaused(PAUSE_TARGET)).toBe(false)
    })

    await test.step('presets: who uses each, and the open drafts', async () => {
      await tabs.getByRole('link', { name: 'Presets' }).click()
      await expect(
        main.getByRole('heading', { level: 1, name: 'Nameserver presets' }),
      ).toBeVisible()
      const all = main.getByRole('region', { name: /^All presets · \d+$/ })
      await expect(all).toBeVisible()
      const usage = all.locator(`[data-usage="${preset.id}"]`).filter({ visible: true }).first()
      await expect(usage).toHaveText(/^[1-9][\d,]* domains? · [\d,]+ orders? · [\d,]+ lines?$/)
      await expect(
        all.locator(`[data-draft="${preset.id}"]`).filter({ visible: true }).first(),
      ).toBeVisible()
      await expect(
        all.getByRole('link', { name: preset.provider, exact: true }).filter({ visible: true }),
      ).toHaveCount(1)

      // The overview's link: only presets with an open draft, and new hosts' drafts.
      await page.goto('/admin/settings/presets?status=draft')
      const chips = main.getByRole('navigation', { name: 'Preset state' })
      await expect(chips.getByRole('link', { name: /^Open drafts \(\d+\)$/ })).toHaveAttribute(
        'aria-current',
        'true',
      )
      await expect(main.getByRole('region', { name: /^Open drafts · \d+$/ })).toBeVisible()
      await expect(main.getByRole('region', { name: /^Drafts for new hosts · \d+$/ })).toBeVisible()
      await accessibleEverywhere(page)
    })

    await test.step("one preset's page", async () => {
      await page.goto(`/admin/settings/presets/${preset.id}`)
      await expect(main.getByRole('heading', { level: 1, name: preset.provider })).toBeVisible()
      const facts = main.getByRole('region', { name: 'This preset', exact: true })
      await expect(facts).toContainText(/In use \(Test side\)/)
      await expect(facts).toContainText(/[1-9][\d,]* domains? · /)
      await expect(
        main.getByRole('region', { name: /^(Open draft|Change the nameservers)$/ }),
      ).toContainText('Only the owner saves, publishes or shows a preset again')
      await accessibleEverywhere(page)
    })

    await test.step('SSL products', async () => {
      await page.goto('/admin/settings/ssl-products')
      await expect(main.getByRole('heading', { level: 1, name: 'SSL products' })).toBeVisible()
      await expect(
        main.getByRole('region', { name: /^Products · \d+, \d+ on sale$/ }),
      ).toBeVisible()
      await accessibleEverywhere(page)
    })

    await test.step("admins: only this admin's own row, with its linked device", async () => {
      await tabs.getByRole('link', { name: 'Admins' }).click()
      await expect(main.getByRole('heading', { level: 1, name: 'Admins' })).toBeVisible()
      const admins = main.getByRole('region', { name: 'Admins · 1', exact: true })
      await expect(admins).toContainText(
        'Admins and their linked devices are changed in the SQL editor (DEPLOY.md §6b).',
      )
      await expect(admins.getByText(label, { exact: true }).filter({ visible: true })).toHaveCount(
        1,
      )
      await expect(
        admins.locator(`[data-devices="${label}"]`).filter({ visible: true }),
      ).toHaveText('1 linked, 1 active')
      await expect(admins.getByText('Test', { exact: true }).filter({ visible: true })).toHaveCount(
        1,
      )
      await accessibleEverywhere(page)
    })
  })
})
