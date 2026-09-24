import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { deleteCartsHolding, TEST_DOMAIN_PREFIX } from './support/accounts.mjs'

/**
 * Bulk search (PRD FR-S5), international names (FR-S8) and the length rules
 * (FR-S9, unit-tested — the catalogue has no length data to exercise here)
 * against the mock gateway in tests/e2e/support — never the live supplier
 * (N12). Names map to fixed answers there; `failonce*` fails its first
 * request only.
 *
 * Bulk searches are limited per address, so each test gets its own made-up
 * one: runs on five devices, and other builders' runs, never share a count.
 */
const testAddress = () =>
  `198.18.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-real-ip': testAddress() })
})

const results = (page: Page) =>
  page.getByRole('list', { name: 'Results, one row per name' }).getByRole('listitem')
/** The row for one name — matched on the name itself, not a note or label that mentions it. */
const row = (page: Page, name: string) =>
  results(page).filter({ has: page.getByText(name, { exact: true }) })
const summary = (page: Page) => page.locator('section[aria-labelledby="bulk-summary"]')
const unchecked = (page: Page) => page.getByRole('region', { name: /(weren|wasn)’t checked$/ })
const bulkForm = (page: Page) => page.getByRole('form', { name: 'Bulk search' })

async function openBulk(page: Page) {
  await page.goto('/search/bulk')
  await page.locator('form[data-enhanced="true"]').waitFor()
}

/** Checks a list and waits until every block has answered. */
async function bulkSearch(page: Page, names: string[]) {
  await openBulk(page)
  await bulkForm(page).getByLabel('Names to check').fill(names.join('\n'))
  await bulkForm(page).getByRole('button', { name: 'Check names' }).click()
  await finished(page)
}

async function finished(page: Page, timeout = 30_000) {
  await expect(summary(page)).toBeVisible()
  await expect(summary(page).getByRole('heading', { level: 2 })).not.toHaveText(/^Checking/, {
    timeout,
  })
}

test.describe('bulk search', () => {
  test('the search page links to it', async ({ page }) => {
    await page.goto('/search?q=getpaid')
    await page.getByRole('link', { name: 'Search many at once' }).click()
    await expect(page).toHaveURL(/\/search\/bulk$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Search many names at once')
    await expect(page.getByText('Paste a list to check it in one go')).toBeVisible()
  })

  test('checks 500 pasted names in blocks, not one request per name (FR-S5)', async ({ page }) => {
    test.setTimeout(60_000)
    const id = unique()
    const names = Array.from({ length: 500 }, (_, index) => `bulk${id}n${index}`)
    const actions: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.headers()['next-action'])
        actions.push(request.url())
    })

    await bulkSearch(page, names)

    await expect(summary(page).getByRole('heading', { level: 2 })).toHaveText(
      '500 of 500 available',
    )
    await expect(summary(page).getByRole('status')).toHaveText('500 of 500 names checked')
    // 500 names on one extension: 25 blocks of twenty, one supplier call each. The mock
    // refuses a bulk block over the supplier's 20-check ceiling, so every name answering
    // above also proves no block was too big.
    expect(actions).toHaveLength(25)
    await expect(results(page)).toHaveCount(100)
    await page.getByRole('button', { name: 'Show 100 more of 400 not shown' }).click()
    await expect(results(page)).toHaveCount(200)
  })

  test('every line gets its own answer, with both prices on every free name (N8)', async ({
    page,
  }) => {
    await bulkSearch(page, [
      'getpaid',
      'takenbrand.net',
      'hotel.africa',
      'not_a_name',
      'getpaid.edu',
    ])

    await expect(results(page)).toHaveCount(5)
    const free = row(page, 'getpaid.com')
    await expect(free).toContainText('Available')
    await expect(free).toContainText(/₦[\d,]+\s*then ₦[\d,]+\/yr/)
    await expect(free.getByRole('checkbox', { name: 'Select getpaid.com' })).not.toBeChecked()
    await expect(row(page, 'takenbrand.net')).toContainText('Taken')
    await expect(row(page, 'hotel.africa')).toContainText('Premium')
    await expect(row(page, 'hotel.africa')).not.toContainText('₦')
    await expect(row(page, 'not_a_name')).toContainText('Not a domain')
    await expect(row(page, 'getpaid.edu')).toContainText("We don't sell .edu")

    await expect(summary(page).getByRole('heading')).toHaveText('1 of 5 available')
  })

  test('names without an extension are checked on each one ticked', async ({ page }) => {
    await openBulk(page)
    const form = bulkForm(page)
    await expect(form.getByRole('checkbox', { name: '.com' })).toBeChecked()
    await form.getByLabel('Names to check').fill('getpaid')
    await form.getByRole('checkbox', { name: '.net' }).check()
    await form.getByRole('button', { name: 'Check names' }).click()
    await finished(page)

    await expect(row(page, 'getpaid.com')).toContainText('Available')
    await expect(row(page, 'getpaid.net')).toContainText('Available')
  })

  test('a list that is too long is refused before anything is asked', async ({ page }) => {
    await openBulk(page)
    const form = bulkForm(page)
    const names = Array.from({ length: 501 }, (_, index) => `name${index}`)
    await form.getByLabel('Names to check').fill(names.join('\n'))
    await form.getByRole('button', { name: 'Check names' }).click()

    await expect(form.getByRole('alert')).toContainText("That's 501 names")
    await expect(page.getByText('Paste a list to check it in one go')).toBeVisible()
  })

  test('reads a CSV file, says what it skipped, and checks it', async ({ page }) => {
    await openBulk(page)
    const form = bulkForm(page)
    await form.getByLabel('Upload a CSV file').setInputFiles({
      name: 'clients.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'client,Domain,notes\nAda,getpaid.com,x\nBola,,\nChi,GETPAID.COM,dup\nDayo,takenbrand.net,y\n',
      ),
    })

    await expect(
      form.getByText(/^Read 2 names from the “Domain” column of clients\.csv\./),
    ).toContainText('Left out 1 blank row and 1 repeat.')
    await expect(form.getByLabel('Names to check')).toHaveValue('getpaid.com\ntakenbrand.net')

    await form.getByRole('button', { name: 'Check names' }).click()
    await finished(page)
    await expect(row(page, 'getpaid.com')).toContainText('Available')
    await expect(row(page, 'takenbrand.net')).toContainText('Taken')
  })

  test('a failed block says which names were not checked, and retries just those', async ({
    page,
  }) => {
    const id = unique()
    const names = [`failonce${id}`, ...Array.from({ length: 59 }, (_, index) => `ok${id}n${index}`)]
    await bulkSearch(page, names)

    await expect(unchecked(page)).toHaveAccessibleName('20 names weren’t checked')
    await expect(unchecked(page)).toContainText(`failonce${id}.com`)
    await expect(summary(page).getByRole('heading')).toHaveText('40 of 60 available')

    await unchecked(page).getByRole('button', { name: 'Check these 20 again' }).click()
    await finished(page)
    await expect(summary(page).getByRole('heading')).toHaveText('60 of 60 available')
    await expect(unchecked(page)).toHaveCount(0)
  })

  test('a registry outage leaves the names not checked, with a way to try again', async ({
    page,
  }) => {
    await bulkSearch(page, ['gatewaydown'])
    await expect(row(page, 'gatewaydown.com')).toContainText('Not checked')
    await expect(unchecked(page)).toContainText("The registry didn't answer")
    await expect(unchecked(page).getByRole('button', { name: 'Check it again' })).toBeEnabled()
  })

  test('filters by available, taken, premium and not checked', async ({ page }) => {
    await bulkSearch(page, ['getpaid', 'takenbrand', 'hotel.africa', 'flakycheck.app'])

    await page.getByRole('radio', { name: /^Taken/ }).check()
    await expect(results(page)).toHaveCount(1)
    await expect(row(page, 'takenbrand.com')).toBeVisible()

    await page.getByRole('radio', { name: /^Premium/ }).check()
    await expect(results(page)).toHaveCount(1)
    await expect(row(page, 'hotel.africa')).toBeVisible()

    await page.getByRole('radio', { name: /^Not checked/ }).check()
    await expect(results(page)).toHaveCount(1)
    await expect(row(page, 'flakycheck.app')).toBeVisible()

    await page.getByRole('radio', { name: /^Available/ }).check()
    await expect(results(page)).toHaveCount(1)
    await expect(row(page, 'getpaid.com')).toBeVisible()

    await page.getByRole('radio', { name: /^All/ }).check()
    await expect(results(page)).toHaveCount(4)
  })

  test('downloads the results as CSV, with both prices on every free name', async ({ page }) => {
    await bulkSearch(page, ['getpaid', 'takenbrand', 'not_a_name'])

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download 3 as CSV' }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/^bulk-search-\d{4}-\d{2}-\d{2}\.csv$/)
    const text = (await readFile(await download.path(), 'utf8')).replace(/^\uFEFF/, '')
    const lines = text.split('\r\n')
    expect(lines[0]).toBe('name,extension,status,first_year_price_ngn,renewal_price_ngn,ascii_name')
    expect(lines[1]).toMatch(/^getpaid\.com,com,available,\d+\.\d{2},\d+\.\d{2},getpaid\.com$/)
    expect(lines[2]).toBe('takenbrand.com,com,taken,,,takenbrand.com')
    expect(lines[3]).toBe('not_a_name,,not a domain,,,')
  })

  test('adds the names selected, and they are in the cart', async ({ page }) => {
    const plain = `${TEST_DOMAIN_PREFIX}bulk${unique()}`
    try {
      await bulkSearch(page, [plain, `${plain}.net`, 'takenbrand'])

      // Nothing is ticked for anyone (N9).
      const cart = page.getByRole('region', { name: 'Add to cart' })
      await expect(cart.getByText('0 selected')).toBeVisible()
      await cart.getByRole('button', { name: 'Select all 2 available' }).click()
      await cart.getByRole('button', { name: 'Add 2 to cart' }).click()
      // Each name is re-checked and written to the cart first: seconds, more under load.
      await expect(cart.getByRole('status')).toContainText('Added 2 names to your cart.', {
        timeout: 20_000,
      })
      await cart.getByRole('link', { name: 'View cart' }).click()

      const lines = page.getByRole('list', { name: 'Domains in your cart' }).getByRole('listitem')
      await expect(lines.getByRole('heading')).toHaveText([`${plain}.com`, `${plain}.net`])
    } finally {
      await deleteCartsHolding([`${plain}.com`, `${plain}.net`])
    }
  })

  test('checks names sent in the address once the page is ready', async ({ page }) => {
    await page.goto('/search/bulk?names=getpaid%0Atakenbrand&tld=com')
    await finished(page)
    await expect(bulkForm(page).getByLabel('Names to check')).toHaveValue('getpaid\ntakenbrand')
    await expect(row(page, 'getpaid.com')).toContainText('Available')
    await expect(row(page, 'takenbrand.com')).toContainText('Taken')
  })

  test('limits how many names one address checks, and says so', async ({ page }) => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'one device is enough to count')
    test.setTimeout(300_000)
    const id = unique()
    await openBulk(page)
    await bulkForm(page).getByRole('checkbox', { name: '.net' }).check()
    await bulkForm(page).getByRole('checkbox', { name: '.org' }).check()

    // 120 blocks of up to 20 checks per ten minutes; 500 names on three extensions is 75, so
    // the second list runs out. The count runs in fixed windows, so if one closes meanwhile
    // the next fills within two more lists.
    for (let list = 0; list < 5; list += 1) {
      const names = Array.from({ length: 500 }, (_, index) => `limit${id}l${list}n${index}`)
      await bulkForm(page).getByLabel('Names to check').fill(names.join('\n'))
      await bulkForm(page).getByRole('button', { name: 'Check names' }).click()
      await finished(page, 90_000)
      if ((await unchecked(page).count()) > 0) break
    }

    await expect(unchecked(page)).toContainText(
      'This connection has checked a lot of names in the last few minutes',
    )
    await expect(unchecked(page)).toContainText('single searches still work meanwhile')
  })
})

test.describe('international names (FR-S8)', () => {
  test('a Unicode name is searched in its ASCII form and shown as read', async ({ page }) => {
    await page.goto('/search')
    await page.locator('form[data-enhanced="true"]').waitFor()
    const form = page.getByRole('form', { name: 'Domain search', exact: true })
    await form.getByLabel('Find your domain').fill('Café.com')
    await form.getByRole('button', { name: /search/i }).click()

    await expect(page).toHaveURL(/\/search\?q=caf%C3%A9\.com$/)
    const exact = page.locator('article[aria-labelledby="exact-domain"]')
    await expect(exact.getByRole('heading')).toHaveText('café.com')
    await expect(exact).toContainText('xn--caf-dma.com')
    await expect(exact.getByRole('button', { name: 'Add café.com to cart' })).toBeVisible()
  })

  test('an extension that refuses international names says so', async ({ page }) => {
    await page.goto(`/search?q=${encodeURIComponent('café.app')}`)
    await expect(page.locator('article[aria-labelledby="exact-domain"]')).toContainText(
      'Not available for this extension',
    )
  })

  test('a name mixing lookalike alphabets is refused, with the reason', async ({ page }) => {
    // The second letter is Cyrillic а (U+0430).
    await page.goto(`/search?q=${encodeURIComponent('pаypal.com')}`)
    await expect(page.getByText('That name mixes alphabets')).toBeVisible()
    await expect(page.getByText(/different alphabets \(Latin and Cyrillic\)/)).toBeVisible()
  })

  test('a name that can pass for a Latin one is flagged in a bulk search', async ({ page }) => {
    await bulkSearch(page, ['аррӏе.com', 'café.com'])
    await expect(row(page, 'аррӏе.com')).toContainText('Can pass for “apple”')
    await expect(row(page, 'café.com')).toContainText('xn--caf-dma.com')
  })
})

test.describe('bulk search quality', () => {
  test('has no detectable accessibility violations', async ({ page }) => {
    await bulkSearch(page, [
      'getpaid',
      'takenbrand.net',
      'café.com',
      'not_a_name',
      'flakycheck.app',
    ])
    await page
      .getByRole('region', { name: 'Add to cart' })
      .getByRole('button', {
        name: /^Select all/,
      })
      .click()
    const report = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(report.violations).toEqual([])
  })

  test('never scrolls horizontally, even with long names', async ({ page }) => {
    await page.goto(
      `/search/bulk?names=${encodeURIComponent(`${'a'.repeat(60)}\n${'ö'.repeat(30)}.com\nflakycheck.app\ngetpaid`)}`,
    )
    await finished(page)

    for (const width of [320, 375, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(100)
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      expect(overflows, `horizontal overflow at ${width}px`).toBe(false)
    }
  })
})
