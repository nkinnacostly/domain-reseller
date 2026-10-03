import { readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import {
  createAdminTestUser,
  createTestUser,
  deleteTestUser,
  hasAdminSchema,
  settleRegistration,
} from './support/accounts.mjs'
import { type AdminUser, expect, signInAsAdmin, test } from './support/admin'
import {
  fillRegistrant,
  payOnMockFlutterwave,
  signInWithDomainInCart,
  type TestUser,
  uniqueName,
} from './support/checkout-flow'

/**
 * /admin/money (docs/ADMIN-SPEC.md §5.2 B7, §9): as a test-only operator, so
 * the Test side. A customer first buys a name through the mock Flutterwave
 * (N12) and its registration is settled, so today has a paid, completed line
 * with no recorded cost. Then: the dates from the overview's link, grain
 * switching, every figure's side and VAT, the margin's source column and its
 * lost row, both CSV files and their formula guard, axe and no sideways
 * scroll. One desktop and one phone: sign-ins are rate-limited per address.
 */

const PROJECTS = ['chromium-desktop', 'mobile-android']

const CAPTION =
  "Margin is shown at the rate we charged, and only for lines whose cost is known — matched to DomainNameAPI's ledger, or recorded at checkout."

const LAGOS_DAY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Africa/Lagos',
})

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

/** RFC 4180, as the page writes it: CRLF records, quoted cells with doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  for (const line of text.split('\r\n')) {
    if (!line) continue
    const cells: string[] = []
    let cell = ''
    let quoted = false
    for (let index = 0; index < line.length; index++) {
      const char = line[index]
      if (quoted) {
        if (char === '"' && line[index + 1] === '"') {
          cell += '"'
          index++
        } else if (char === '"') quoted = false
        else cell += char
      } else if (char === '"') quoted = true
      else if (char === ',') {
        cells.push(cell)
        cell = ''
      } else cell += char
    }
    cells.push(cell)
    rows.push(cells)
  }
  return rows
}

/**
 * The formula guard: no cell a spreadsheet would run. A cell starting with
 * = + - @, a tab or a carriage return is either a plain number (a negative
 * figure) or text the guard turned into text with an apostrophe.
 */
function expectGuarded(rows: string[][]) {
  for (const row of rows) {
    for (const cell of row) {
      if (/^[=+\-@\t\r]/.test(cell))
        expect(cell, 'a cell that would run').toMatch(/^-\d+(\.\d{2})?$/)
    }
  }
}

/** Saves a CSV through its button, and reads the file the browser was handed. */
async function download(page: Page, button: Locator) {
  const [file] = await Promise.all([page.waitForEvent('download'), button.click()])
  const path = await file.path()
  return { name: file.suggestedFilename(), text: readFileSync(path, 'utf8') }
}

test.describe('the money page', () => {
  let admin: AdminUser | undefined
  let customer: TestUser | undefined

  test.beforeEach(async () => {
    test.skip(!PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migrations 40–41 are not applied to this database')
    customer = (await createTestUser('money')) as TestUser
    admin = (await createAdminTestUser('money')) as AdminUser
  })

  test.afterEach(async () => {
    // Deleting the customer purges their test order, its payment and its line.
    if (customer) await deleteTestUser(customer.id)
    if (admin) await deleteTestUser(admin.user.id)
    customer = undefined
    admin = undefined
  })

  test('shows sales and margin on the Test side, by day, week or month, and saves them as CSV', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    if (!admin || !customer) throw new Error('no users')

    // A paid test order, registered: a sale today, and a line with no recorded cost.
    const name = uniqueName()
    await signInWithDomainInCart(page, customer, name)
    await fillRegistrant(page)
    const orderId = await payOnMockFlutterwave(page, 'Pay (test)')
    await settleRegistration(orderId, 'registered')
    await page.context().clearCookies()

    const today = LAGOS_DAY.format(new Date())
    await signInAsAdmin(page, admin, '/admin/money')
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { level: 1, name: 'Money' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Test', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(
      main.getByText(/^Sales, VAT, refunds, fees and margin on the test side, .+, by day\.$/),
    ).toBeVisible()

    // The sidebar says where we are (S13); on a phone it is a drawer. The sidebar
    // streams in, so wait for it or the menu button before deciding which.
    const moneyLink = page
      .getByRole('navigation', { name: 'Admin' })
      .getByRole('link', { name: 'Money' })
      .filter({ visible: true })
    const openMenu = page.getByRole('button', { name: 'Open menu' }).filter({ visible: true })
    await expect(moneyLink.or(openMenu).first()).toBeVisible()
    if (await openMenu.count()) await openMenu.click()
    await expect(moneyLink.first()).toHaveAttribute('aria-current', 'page')

    // The overview's link (§9's contract): the dates it sends are the dates shown.
    await page.goto(`/admin/money?from=${today}&to=${today}`)
    const dates = main.getByRole('form', { name: 'Dates' })
    await expect(dates.getByLabel('From')).toHaveValue(today)
    await expect(dates.getByLabel('To')).toHaveValue(today)

    // Sales: every total says its side and where VAT stands; today has the order.
    const revenue = main.getByRole('region', { name: 'Sales, cash and refunds' })
    await expect(
      revenue.getByText(/^Test side · .+ · in naira, VAT shown on its own$/),
    ).toBeVisible()
    const totals = revenue.locator('[data-total]')
    await expect(totals).toHaveCount(8)
    for (let index = 0; index < 8; index++) await expect(totals.nth(index)).toContainText('Test')
    await expect(revenue.locator('[data-total="net"]')).toContainText('VAT excluded')
    await expect(revenue.locator('[data-total="cash"]')).toContainText('VAT included')
    const ordersPaid = Number(
      (await revenue.locator('[data-total="orders"]').innerText())
        .match(/([\d,]+)/)?.[1]
        ?.replace(/,/g, ''),
    )
    expect(ordersPaid).toBeGreaterThanOrEqual(1)
    await expect(revenue.locator('figure svg[role="img"]')).toHaveCount(2)

    // Margin: the caption, the source column, our uncosted line, and the lost row.
    const margin = main.getByRole('region', { name: 'Margin' })
    await expect(margin.locator('[data-margin-caption]')).toContainText(CAPTION)
    await expect(margin.locator('[data-margin-caption]')).toContainText(
      /\d+ lines? sold before costs were recorded (is|are) left out\.$/,
    )
    const lost = margin.locator('[data-margin-row="lost"]').filter({ visible: true })
    await expect(lost).toHaveText('Supplier cost on failed or refunded lines')
    await expect(
      margin.locator('[data-margin-row="register:none"]').filter({ visible: true }),
    ).toHaveText('Registrations')
    const wide = (page.viewportSize()?.width ?? 0) >= 1280
    if (wide) {
      const table = margin.getByRole('table', { name: /^Margin by what was sold/ })
      await expect(table.getByRole('columnheader', { name: 'Source', exact: true })).toBeVisible()
      const uncosted = table
        .getByRole('row')
        .filter({ has: page.locator('[data-margin-row="register:none"]') })
      await expect(uncosted).toContainText('Not costed')
      await expect(uncosted).toContainText('Not known')
      await expect(
        table.getByRole('row').filter({ has: page.locator('[data-margin-row="lost"]') }),
      ).toContainText("DomainNameAPI's ledger")
    } else {
      const card = margin
        .getByRole('listitem')
        .filter({ has: page.locator('[data-margin-row="register:none"]') })
      await expect(card.getByText('Source', { exact: true })).toBeVisible()
      await expect(card).toContainText('Not costed')
    }

    // Grain switching: links that keep the dates, the chosen one marked.
    const grains = main.getByRole('navigation', { name: 'Group by' })
    await expect(grains.getByRole('link', { name: 'Day' })).toHaveAttribute('aria-current', 'true')
    await grains.getByRole('link', { name: 'Week' }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/money\\?from=${today}&to=${today}&grain=week$`))
    await expect(grains.getByRole('link', { name: 'Week' })).toHaveAttribute('aria-current', 'true')
    await expect(grains.getByRole('link', { name: 'Day' })).not.toHaveAttribute('aria-current')
    await expect(
      revenue.getByRole('img', {
        name: /^Net sales by week, VAT excluded, in naira, the test side\./,
      }),
    ).toBeVisible()
    await grains.getByRole('link', { name: 'Month' }).click()
    await expect(page).toHaveURL(/&grain=month$/)
    await expect(
      revenue.getByRole('img', {
        name: /^Cash in by month, VAT included, in naira, the test side\./,
      }),
    ).toBeVisible()

    // New dates through the form keep the chosen grain.
    await dates.getByLabel('From').fill(today)
    await dates.getByRole('button', { name: 'Show' }).click()
    await expect(page).toHaveURL(
      new RegExp(`/admin/money\\?from=${today}&to=${today}&grain=month$`),
    )

    // The sales file: a BOM, the side and VAT in its headings, nothing a spreadsheet would run.
    const sales = await download(
      page,
      revenue.getByRole('button', { name: /^Download CSV of sales, cash and refunds by month/ }),
    )
    expect(sales.name).toBe(`money-sales-test-${today}-to-${today}-by-month.csv`)
    expect(sales.text.startsWith('﻿')).toBe(true)
    const salesRows = parseCsv(sales.text.slice(1))
    expect(salesRows[0]).toEqual([
      'Side',
      'Period start',
      'Period end',
      'Orders paid',
      'Net sales excluding VAT (NGN)',
      'VAT collected (NGN)',
      'Cash in including VAT (NGN)',
      'Line refunds excluding VAT (NGN)',
      'VAT returned with line refunds (NGN)',
      'Charge refunds with no VAT (NGN)',
      'Flutterwave fees (NGN)',
      'Fees we absorbed (NGN)',
    ])
    expect(salesRows[1]?.slice(0, 3)).toEqual(['Test', today, today])
    for (const figure of salesRows[1]?.slice(4) ?? []) expect(figure).toMatch(/^-?\d+\.\d{2}$/)
    expectGuarded(salesRows)

    // The margin file: each source, the lost row, the total — guarded the same way.
    const marginFile = await download(
      page,
      margin.getByRole('button', { name: /^Download CSV of margin/ }),
    )
    expect(marginFile.name).toBe(`money-margin-test-${today}-to-${today}.csv`)
    const marginRows = parseCsv(marginFile.text.slice(1))
    expect(marginRows[0]?.[9]).toBe('Cost source')
    const labels = marginRows.slice(1).map((row) => row[3])
    expect(labels).toContain('Supplier cost on failed or refunded lines')
    expect(labels.at(-1)).toBe('Total, lines with a known cost')
    expect(marginRows.some((row) => row[3] === 'Registrations' && row[9] === 'Not costed')).toBe(
      true,
    )
    expectGuarded(marginRows)

    // Accessible, and no sideways scroll from a phone to a wide screen.
    const results = await axe(page)
    expect(results.violations).toEqual([])
    for (const width of [320, 375, 768, 1024, 1440, 1920]) {
      expect(await overflowAt(page, width), `overflow at ${width}`).toBeLessThanOrEqual(1)
    }
  })
})
