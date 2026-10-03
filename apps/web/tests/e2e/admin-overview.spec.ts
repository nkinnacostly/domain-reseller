import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { createAdminTestUser, deleteTestUser, hasAdminSchema } from './support/accounts.mjs'
import { type AdminUser, expect, SIGN_IN_PROJECTS, signInAsAdmin, test } from './support/admin'
import { seedTestFailedEmail } from './support/admin-seed.mjs'

/**
 * /admin, the overview (docs/ADMIN-SPEC.md §5.2 B1, §9): as a test-only
 * operator, so the Test side — health, the "needs a person" tiles and their
 * filtered links, sales by period, the float, charts with their figures for
 * screen readers, the latest orders; no axe violations and no sideways
 * scroll. One sign-in per project: sign-ins are rate-limited per address.
 * Android joins the sign-in projects here for the phone layout.
 */

const OVERVIEW_PROJECTS = [...SIGN_IN_PROJECTS, 'mobile-android']

/** Each tile's list, filtered to what admin_attention_counts counted. */
const ATTENTION_LINKS: Record<string, string> = {
  refunds: '/admin/refunds?status=held,failed,needs_attention',
  jobs: '/admin/queue?status=needs_attention',
  alertsCritical: '/admin/alerts?severity=critical',
  drift: '/admin/alerts?tab=drift',
  incidents: '/admin/refunds/incidents?status=unresolved',
  stuckOrders: '/admin/orders?stuck=1',
  pendingWithoutJob: '/admin/queue?tab=pending-without-job',
  emailsFailed: '/admin/emails?status=failed',
  ledgerUnexplained: '/admin/supplier/ledger?status=unexplained',
  presetDrafts: '/admin/settings/presets?status=draft',
}

const TEST_ADMIN_BANNER =
  "Test administrator: live records and customers' details are hidden, and live actions are refused."

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

test.describe('the admin overview', () => {
  let admin: AdminUser | undefined

  test.beforeEach(async () => {
    test.skip(!OVERVIEW_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migration 40 is not applied to this database')
    admin = (await createAdminTestUser('overview')) as AdminUser
    // A failed test email of this admin's own: the tile below counts at least it.
    await seedTestFailedEmail(admin.user.id)
  })
  test.afterEach(async () => {
    // Deleting the user takes the seeded email with it (email_outbox cascades).
    if (admin) await deleteTestUser(admin.user.id)
    admin = undefined
  })

  test('shows the Test side at a glance, every tile linking to its filtered list', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    if (!admin) throw new Error('no admin')
    await signInAsAdmin(page, admin, '/admin')
    const main = page.getByRole('main')

    await expect(main.getByRole('heading', { level: 1, name: 'Operations' })).toBeVisible()
    await expect(page.getByRole('note').filter({ hasText: TEST_ADMIN_BANNER })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Test' })).toHaveAttribute('aria-pressed', 'true')
    await expect(main.getByText(/^It’s \w+day \d{1,2} \w+ \d{4}$/)).toBeVisible()

    // Health: a dot and a word per service; a test administrator is shown no cron jobs.
    const health = main.getByRole('region', { name: 'Health' })
    await expect(health.getByRole('listitem')).toHaveCount(8)
    await expect(health.locator('[data-health="cron"]')).toContainText('Hidden')
    await expect(health.locator('[data-health="cron"]')).toContainText(
      'Not shown to test administrators',
    )
    await expect(health.locator('[data-health="catalogue"]')).toContainText('Live only')

    // Needs a person: every tile is a link to its list with the filter, its count in its name.
    const attention = main.getByRole('region', { name: 'Needs a person' })
    for (const [key, href] of Object.entries(ATTENTION_LINKS)) {
      const link = attention.locator(`[data-attention="${key}"] a`)
      await expect(link, key).toHaveAttribute('href', href)
      await expect(link, key).toHaveAccessibleName(/\s\d[\d,]*(\s|$)/)
    }
    const failedEmails = attention.locator('[data-attention="emailsFailed"] a')
    const failedCount = Number(
      (await failedEmails.innerText()).match(/Failed emails\s+([\d,]+)/)?.[1]?.replace(/,/g, ''),
    )
    expect(failedCount).toBeGreaterThanOrEqual(1)

    // Sales: ten figures, each a link; the period is in the URL and marked.
    const sales = main.getByRole('region', { name: 'Sales' })
    await expect(sales.locator('[data-kpi] a')).toHaveCount(10)
    const periods = sales.getByRole('navigation', { name: 'Sales period' })
    await expect(periods.getByRole('link', { name: '30 days' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await periods.getByRole('link', { name: '7 days' }).click()
    await expect(page).toHaveURL(/\/admin\?period=7$/)
    await expect(periods.getByRole('link', { name: '7 days' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await expect(sales.locator('[data-kpi="cash"] a')).toContainText('Last 7 days')
    await expect(sales.locator('[data-kpi="cash"] a')).toHaveAttribute(
      'href',
      /^\/admin\/money\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/,
    )
    // What was sold is counted over the same period, and says so.
    await expect(sales.locator('[data-kpi="register"] a')).toContainText('Last 7 days')

    // The float: balance with runway, and the 21-day target, both opening Supplier.
    const float = main.getByRole('region', { name: 'Supplier float' })
    await expect(float.locator('[data-float="balance"] a')).toHaveAttribute(
      'href',
      '/admin/supplier',
    )
    // 21 days of spend, or — before the ledger is ever read on the side — not known yet.
    await expect(float.locator('[data-float="target"] a')).toContainText(
      /21 days of spend|Not known until the supplier ledger has been read on this side/,
    )

    // Charts: every picture is named, with its figures in a table for screen readers.
    const charts = main.locator('figure:has(svg[role="img"])')
    expect(await charts.count()).toBeGreaterThanOrEqual(2)
    for (let index = 0; index < (await charts.count()); index++) {
      const chart = charts.nth(index)
      const name = (await chart.locator('svg[role="img"]').getAttribute('aria-label')) ?? ''
      expect(name).toMatch(/\. The figures follow in a table\.$/)
      const caption = name.replace('. The figures follow in a table.', '')
      const table = chart.locator('table.sr-only')
      await expect(table).toHaveCount(1)
      await expect(table.locator('caption')).toHaveText(caption)
      expect(await table.locator('tbody tr').count()).toBeGreaterThan(0)
      // In the accessibility tree by its caption, though drawn nowhere.
      await expect(chart.getByRole('table', { name: caption, exact: true })).toHaveCount(1)
    }

    // The latest paid orders: a list, or the empty state.
    const orders = main.getByRole('region', { name: 'Latest paid orders' })
    await expect(
      orders.getByText('No paid orders on this side yet.').or(orders.getByRole('link').nth(1)),
    ).toBeVisible()
    await expect(main.getByRole('link', { name: 'Open the audit log' })).toHaveAttribute(
      'href',
      '/admin/audit',
    )

    const results = await axe(page)
    expect(results.violations).toEqual([])
    for (const width of [320, 375, 768, 1024, 1440, 1920]) {
      expect(await overflowAt(page, width), `overflow at ${width}`).toBeLessThanOrEqual(1)
    }

    // A tile opens its list with the filter in the address.
    await page.setViewportSize({ width: 1280, height: 900 })
    await failedEmails.click()
    await expect(page).toHaveURL(/\/admin\/emails\?status=failed$/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })
})
