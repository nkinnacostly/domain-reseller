import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { adminHrefForAlertKey } from '../../../../packages/shared/src/admin/alert-href'
import { createAdminTestUser, deleteTestUser, hasAdminSchema } from './support/accounts.mjs'
import { type AdminUser, expect, SIGN_IN_PROJECTS, signInAsAdmin, test } from './support/admin'

/**
 * Alerts and health (docs/ADMIN-SPEC.md §5.2, §9 B5), as a test-only
 * operator on the Test side: every tab renders; each alert links where
 * `adminHrefForAlertKey` says; the Test side says its alerts may be out of
 * date; nothing on the page dismisses anything; and a test administrator
 * sees no cron panel. One sign-in walks all four tabs — sign-ins are
 * rate-limited per address (SIGN_IN_PROJECTS).
 */

const TEST_SIDE_NOTE =
  'Test-side alerts are not re-evaluated by the running gateway; they may be out of date.'
const NO_DISMISS = 'Alerts close by themselves once the condition is gone. There is no dismiss.'
const DRIFT_NOTE = 'Drift closes when the next complete reconcile no longer finds it.'
const WIDTHS = [320, 375, 768, 1024, 1440, 1920]

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
 * Each alert's key, read with the secret key (createAdminTestUser has loaded
 * the root .env by now). Read-only, and only to check the links: the page
 * itself never sends a key to the browser.
 */
async function alertKeys(ids: number[]): Promise<Map<number, { key: string; testMode: boolean }>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!url || !secret)
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await db.from('ops_alerts').select('id, key, test_mode').in('id', ids)
  if (error) throw error
  return new Map((data ?? []).map((row) => [row.id, { key: row.key, testMode: row.test_mode }]))
}

/** Every alert link on the page — card list and table alike — against its key. */
async function expectAlertLinksFromKeys(page: Page) {
  const links = await page.locator('main a[data-alert-id]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: Number(node.getAttribute('data-alert-id')),
      href: node.getAttribute('href') ?? '',
    })),
  )
  if (links.length === 0) return 0
  const keys = await alertKeys([...new Set(links.map((link) => link.id))])
  for (const link of links) {
    const alert = keys.get(link.id)
    expect(alert, `alert ${link.id} exists`).toBeDefined()
    // A test administrator is shown test-side alerts only (D15).
    expect(alert?.testMode, `alert ${link.id} is a test alert`).toBe(true)
    expect(link.href, `alert ${link.id}`).toBe(adminHrefForAlertKey(alert?.key ?? ''))
  }
  return links.length
}

async function expectNoDismissControl(page: Page) {
  const main = page.getByRole('main')
  await expect(
    main.getByRole('button', { name: /dismiss|resolve|acknowledge|mute|snooze|close alert/i }),
  ).toHaveCount(0)
  await expect(main.getByRole('link', { name: /dismiss|resolve|acknowledge|snooze/i })).toHaveCount(
    0,
  )
}

async function openTab(page: Page, name: 'Open' | 'History' | 'Drift' | 'Health', url: RegExp) {
  const tabs = page.getByRole('navigation', { name: 'Alert views' })
  await tabs.getByRole('link', { name, exact: true }).click()
  await expect(page).toHaveURL(url)
  await expect(tabs.getByRole('link', { name, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(tabs.locator('[aria-current="page"]')).toHaveCount(1)
}

async function expectAccessibleAndContained(page: Page, tab: string) {
  const results = await axe(page)
  expect(results.violations, `axe on ${tab}`).toEqual([])
  const viewport = page.viewportSize()
  for (const width of WIDTHS) {
    expect(await overflowAt(page, width), `${tab}: overflow at ${width}`).toBeLessThanOrEqual(1)
  }
  if (viewport) await page.setViewportSize(viewport)
}

test.describe('alerts and health, as a test administrator', () => {
  let admin: AdminUser | undefined

  test.beforeEach(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migration 40 is not applied to this database')
    admin = (await createAdminTestUser('alerts')) as AdminUser
  })
  test.afterEach(async () => {
    if (admin) await deleteTestUser(admin.user.id)
    admin = undefined
  })

  test('every tab renders, links go through adminHrefForAlertKey, and nothing is dismissed', async ({
    page,
  }) => {
    if (!admin) throw new Error('no admin')
    await signInAsAdmin(page, admin, '/admin/alerts')

    await test.step('Open: the side, the notes, and each open alert linked', async () => {
      await expect(page.getByRole('heading', { level: 1, name: 'Alerts and health' })).toBeVisible()
      const tabs = page.getByRole('navigation', { name: 'Alert views' })
      await expect(tabs.getByRole('link', { name: 'Open', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      )
      // A test administrator cannot leave the Test side, and is told what that means here.
      await expect(page.getByRole('button', { name: 'Test' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(page.getByTestId('alerts-test-side-note')).toHaveText(TEST_SIDE_NOTE)
      await expect(page.getByTestId('alerts-no-dismiss')).toHaveText(NO_DISMISS)
      await expect(page.getByRole('heading', { level: 2, name: 'Open alerts' })).toBeVisible()
      const shown = page
        .getByRole('table', { name: 'Open alerts, critical first' })
        .or(page.getByRole('list', { name: 'Open alerts, critical first' }))
        .or(page.getByText('No open alerts', { exact: true }))
      await expect(shown.first()).toBeVisible()
      await expectAlertLinksFromKeys(page)
      await expectNoDismissControl(page)
      await expectAccessibleAndContained(page, 'Open')
    })

    await test.step('History: every alert on the side, filtered by the URL', async () => {
      await openTab(page, 'History', /\/admin\/alerts\?tab=history$/)
      await expect(page.getByRole('heading', { level: 2, name: 'Alert history' })).toBeVisible()
      await expect(page.getByTestId('alerts-test-side-note')).toHaveText(TEST_SIDE_NOTE)
      await expect(page.getByRole('navigation', { name: 'Alert state' })).toBeVisible()
      await expect(page.getByRole('form', { name: 'Seen between' })).toBeVisible()
      const linked = await expectAlertLinksFromKeys(page)
      test.info().annotations.push({
        type: 'alert links checked',
        description: `${linked} links on the test side's history`,
      })
      await expectNoDismissControl(page)
      await expectAccessibleAndContained(page, 'History')

      // A state chip is a link; the URL holds the filter and the chip says it is chosen.
      const states = page.getByRole('navigation', { name: 'Alert state' })
      await states.getByRole('link', { name: 'Closed' }).click()
      await expect(page).toHaveURL(/\/admin\/alerts\?status=resolved&tab=history$/)
      await expect(states.getByRole('link', { name: 'Closed' })).toHaveAttribute(
        'aria-current',
        'true',
      )
      await expectAlertLinksFromKeys(page)
    })

    await test.step('Drift: read-only, and says how it closes', async () => {
      await openTab(page, 'Drift', /\/admin\/alerts\?tab=drift$/)
      await expect(page.getByRole('heading', { level: 2, name: 'Registry drift' })).toBeVisible()
      await expect(page.getByTestId('drift-note')).toHaveText(DRIFT_NOTE)
      // Drift is reconcile state, not an alert list: the alerts note is not repeated here.
      await expect(page.getByTestId('alerts-test-side-note')).toHaveCount(0)
      const shown = page
        .getByRole('table', { name: 'Open registry drift' })
        .or(page.getByRole('list', { name: 'Open registry drift' }))
        .or(page.getByText('No drift', { exact: true }))
      await expect(shown.first()).toBeVisible()
      await expectNoDismissControl(page)
      await expectAccessibleAndContained(page, 'Drift')
    })

    await test.step('Health: services hidden from a test admin, checks, presets, no cron panel', async () => {
      await openTab(page, 'Health', /\/admin\/alerts\?tab=health$/)
      const main = page.getByRole('main')
      for (const name of ['Background services', 'Registry checks', 'Host presets']) {
        await expect(main.getByRole('heading', { level: 2, name })).toBeVisible()
      }
      // service_heartbeats has no side; a test administrator is not shown it (§2.3).
      await expect(
        main.getByText('Not shown to test administrators', { exact: true }),
      ).toBeVisible()
      // §9 B5: the cron panel is hidden for a test admin.
      await expect(main.getByRole('heading', { name: 'Scheduled jobs' })).toHaveCount(0)
      await expect(main.getByRole('table', { name: 'Scheduled jobs' })).toHaveCount(0)
      await expect(main.getByText('email-notices')).toHaveCount(0)
      // Registry checks: the last week's figures, or a plain empty state.
      await expect(
        main
          .getByText('Checks, last 7 days')
          .or(main.getByText("The registry checks couldn't be loaded.")),
      ).toBeVisible()
      // Preset health links to Settings, its count inside the link's name.
      const drafts = main.getByRole('link', { name: /^Drafts waiting \d+/ })
      await expect(drafts).toHaveAttribute('href', '/admin/settings/presets')
      await expectNoDismissControl(page)
      await expectAccessibleAndContained(page, 'Health')
    })

    await test.step('Dark theme: the fullest tabs pass axe too (S3, S8)', async () => {
      await page.evaluate(() => localStorage.setItem('theme', 'dark'))
      for (const path of ['/admin/alerts?tab=history', '/admin/alerts?tab=health']) {
        await page.goto(path)
        await expect(page.locator('html')).toHaveClass(/\bdark\b/)
        const results = await axe(page)
        expect(results.violations, `axe on ${path} in dark`).toEqual([])
      }
      await page.evaluate(() => localStorage.removeItem('theme'))
    })

    await test.step('A Telegram link to a tab lands on it', async () => {
      await page.goto(adminHrefForAlertKey('cron_failed:email-notices'))
      await expect(
        page
          .getByRole('navigation', { name: 'Alert views' })
          .getByRole('link', { name: 'Health', exact: true }),
      ).toHaveAttribute('aria-current', 'page')
      await page.goto(adminHrefForAlertKey('drift:1'))
      await expect(page.getByRole('heading', { level: 2, name: 'Registry drift' })).toBeVisible()
    })
  })
})
