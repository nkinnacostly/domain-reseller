import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import {
  createDemoDomain,
  createSandboxDomain,
  createTestUser,
  deleteTestUser,
  enableTotp,
  freshTotpCode,
  settleDomainChange,
  settleRenewal,
  updateTestDomain,
} from './support/accounts.mjs'

/**
 * The portfolio's tools (PRD FR-P3 labels, FR-P4 bulk actions, FR-N2, FR-N5
 * revert) against demo and sandbox domains. Registry jobs are answered by
 * settleDomainChange() and settleRenewal() through the same database
 * functions the gateway uses; payment is the mock Flutterwave (N12).
 */

type TestUser = { id: string; email: string; password: string }

// Whole journeys — sign in, act, pay, settle — on a dashboard that reads six things at once.
test.describe.configure({ timeout: 90_000 })

const VERCEL = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']
const NETLIFY = ['dns1.p01.nsone.net', 'dns2.p01.nsone.net']

async function signIn(page: Page, user: TestUser, next: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
}

async function signInWithCode(page: Page, user: TestUser, secret: string, next: string) {
  await signIn(page, user, next)
  await expect(page).toHaveURL(/\/verify/)
  const verify = page.getByRole('form', { name: 'Two-factor code' })
  await verify.getByLabel('6-digit code').fill(await freshTotpCode(secret))
  await verify.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(new RegExp(`${next.replaceAll('.', '\\.')}$`))
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

/** No horizontal overflow at 320px (S5, S6); back to the desktop size after. */
async function noOverflowAt320(page: Page) {
  const before = page.viewportSize()
  await page.setViewportSize({ width: 320, height: 900 })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
  if (before) await page.setViewportSize(before)
}

/** The next server action's answer: wait on it, not on `networkidle` (§15). */
const saved = (page: Page) =>
  page.waitForResponse((response) => response.request().method() === 'POST')

/** The table's rows, as the portfolio lists them (§15: `[data-domain]`). */
const listed = (page: Page) =>
  page
    .locator('[data-domain]:visible')
    .evaluateAll((links) => links.map((link) => link.getAttribute('data-domain')))

/** Ticks domains in the table — the desktop layout — once the page has hydrated. */
async function tick(page: Page, ...names: string[]) {
  const table = page.getByRole('table')
  for (const name of names) {
    const box = table.getByRole('checkbox', { name: `Select ${name}`, exact: true })
    // A tick before hydration is undone when React takes over; retry until it holds.
    await expect(async () => {
      await box.check()
      await expect(box).toBeChecked({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
  }
}

const bar = (page: Page) => page.getByRole('region', { name: 'Act on several domains' })

test.describe('portfolio tools', () => {
  let user: TestUser | undefined

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('portfolio-tools', { fullName: 'Ada Okafor' })
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('labels are made in Settings, put on a domain, shown on its row and filter the list (FR-P3)', async ({
    page,
  }) => {
    const owner = user as TestUser
    const first = await createDemoDomain(owner.id, { expiresInDays: 40 })
    const second = await createDemoDomain(owner.id, { expiresInDays: 80 })

    await signIn(page, owner, '/app/settings/labels')
    await expect(page.getByRole('heading', { name: 'No labels yet' })).toBeVisible()
    const form = page.getByRole('form', { name: 'New label' })
    await page.waitForLoadState('networkidle')
    await form.getByLabel('Label name').fill('Acme Ltd')
    await form.getByText('Green', { exact: true }).click()
    const added = saved(page)
    await form.getByRole('button', { name: 'Add label' }).click()
    await added
    await expect(page.getByRole('status').filter({ hasText: 'Added' })).toHaveText(
      'Added “Acme Ltd”.',
    )
    const labels = page.getByRole('list', { name: 'Your labels' })
    await expect(labels).toContainText('Not on any domain yet.')

    // A second label with the same name, whatever the case, is refused.
    await form.getByLabel('Label name').fill('ACME LTD')
    await form.getByRole('button', { name: 'Add label' }).click()
    await expect(form.getByRole('alert')).toContainText('You already have a label called')
    expect((await axe(page)).violations).toEqual([])

    // On the domain's own page.
    await page.goto(`/app/domains/${first.name}`)
    const panel = page.getByRole('region', { name: 'Labels', exact: true })
    await expect(panel).toContainText(`No labels on ${first.name} yet.`)
    await page.waitForLoadState('networkidle')
    await panel.getByRole('button', { name: 'Choose labels' }).click()
    const linked = saved(page)
    await panel.getByRole('checkbox', { name: 'Acme Ltd' }).check()
    await linked
    await page.reload()
    await expect(page.getByRole('region', { name: 'Labels', exact: true })).toContainText(
      'Labels: Acme Ltd',
    )

    // On its row, and as a filter.
    await page.goto('/app/domains')
    const row = page
      .getByRole('table')
      .getByRole('row')
      .filter({ has: page.locator(`[data-domain="${first.name}"]`) })
    await expect(row).toContainText('Acme Ltd')
    await expect.poll(() => listed(page)).toEqual([first.name, second.name])
    const filters = page.getByRole('navigation', { name: 'Labels' })
    await filters.getByRole('link', { name: 'Acme Ltd' }).click()
    await expect(page).toHaveURL(/\/app\/domains\?label=[0-9a-f-]+$/, { timeout: 30_000 })
    await expect.poll(() => listed(page), { timeout: 30_000 }).toEqual([first.name])
    await expect(filters.getByRole('link', { name: 'Acme Ltd' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await filters.getByRole('link', { name: 'Any label' }).click()
    await expect.poll(() => listed(page), { timeout: 30_000 }).toEqual([first.name, second.name])

    // Renamed and recoloured in Settings; the domain count follows.
    await page.goto('/app/settings/labels')
    await expect(page.getByRole('list', { name: 'Your labels' })).toContainText('On 1 domain.')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Edit Acme Ltd' }).click()
    const edit = page.getByRole('form', { name: 'Edit Acme Ltd' })
    await edit.getByLabel('Label name').fill('Acme Group')
    await edit.getByText('Purple', { exact: true }).click()
    const renamed = saved(page)
    await edit.getByRole('button', { name: 'Save label' }).click()
    await renamed
    await expect(page.getByRole('list', { name: 'Your labels' })).toContainText('Acme Group')
    await noOverflowAt320(page)
  })

  test('a bulk change is queued per domain, and its page follows each one to the registry (FR-P4)', async ({
    page,
  }) => {
    const owner = user as TestUser
    const live = await createSandboxDomain(owner.id, { expiresInDays: 100 })
    const refused = await createSandboxDomain(owner.id, { expiresInDays: 120 })
    const demo = await createDemoDomain(owner.id, { expiresInDays: 140 })

    await signIn(page, owner, '/app/domains')
    await expect(page).toHaveURL(/\/app\/domains$/)
    await tick(page, live.name, refused.name, demo.name)
    await expect(bar(page)).toContainText('3 selected')
    await bar(page).getByRole('button', { name: 'Privacy' }).click()
    const form = page.getByRole('form', { name: 'Contact privacy for the selected domains' })
    await expect(form).toContainText('This sends a change to the registry for each domain.')
    expect((await axe(page)).violations).toEqual([])
    await form.getByRole('button', { name: 'Turn privacy on for 3 domains' }).click()

    await expect(page).toHaveURL(/\/app\/domains\/bulk\/[0-9a-f-]+$/, { timeout: 30_000 })
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Contact privacy on for 3 domains',
    )
    const lines = page.getByRole('list', { name: 'Each domain' })
    const line = (name: string) => lines.locator(`[data-bulk-line="${name}"]`)
    await expect(line(live.name)).toContainText('Waiting. Queued for the registry.')
    await expect(line(refused.name)).toContainText('Waiting. Queued for the registry.')
    await expect(line(demo.name)).toContainText('Skipped. A demo domain never reaches a registry.')
    await expect(page.getByRole('main')).toContainText('This page updates as each one is applied.')
    expect((await axe(page)).violations).toEqual([])

    // The gateway's answers, through the same functions; the page catches up by itself.
    await settleDomainChange(live.id, 'set_privacy')
    await settleDomainChange(refused.id, 'set_privacy', 'DOMAIN_NOT_FOUND')
    await expect(line(live.name)).toContainText('Done. The registry confirmed it.', {
      timeout: 30_000,
    })
    await expect(line(refused.name)).toContainText(
      'Failed. The registry does not list this domain in our account.',
    )
    await expect(page.getByRole('list', { name: 'Summary' })).toHaveText(
      /1 done\s*1 failed\s*1 skipped/,
    )
    await noOverflowAt320(page)

    await page.getByRole('link', { name: 'Back to your domains' }).click()
    await expect(page).toHaveURL(/\/app\/domains#portfolio$/, { timeout: 30_000 })
  })

  test('the ticked domains export as CSV, guarded for spreadsheets (FR-P4)', async ({ page }) => {
    const owner = user as TestUser
    const first = await createDemoDomain(owner.id, { expiresInDays: 30 })
    await createDemoDomain(owner.id, { expiresInDays: 60, autoRenew: false })

    await signIn(page, owner, '/app/domains')
    await expect(page).toHaveURL(/\/app\/domains$/)
    await tick(page, first.name)
    const download = page.waitForEvent('download')
    await bar(page).getByRole('button', { name: 'Export 1 as CSV' }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/^domains-\d{4}-\d{2}-\d{2}\.csv$/)
    const text = await readFile((await file.path()) as string, 'utf8')
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const rows = text.slice(1).trim().split('\r\n')
    expect(rows).toEqual([
      'Domain,Status,Expires,Nameservers,Labels,Auto-renew,Transfer lock,Privacy',
      expect.stringMatching(
        new RegExp(`^${first.name.replaceAll('.', '\\.')},Active,\\d{4}-\\d{2}-\\d{2},,,On,On,On$`),
      ),
    ])

    // Nothing ticked: everything shown.
    await bar(page).getByRole('button', { name: 'Clear' }).click()
    const all = page.waitForEvent('download')
    await bar(page).getByRole('button', { name: 'Export all as CSV' }).click()
    const everything = await readFile((await (await all).path()) as string, 'utf8')
    expect(everything.trim().split('\r\n')).toHaveLength(3)
  })

  test('several domains renew in one order, paid once, each line followed to the registry (FR-P4, FR-P5)', async ({
    page,
  }) => {
    const owner = user as TestUser
    const soon = await createSandboxDomain(owner.id, { expiresInDays: 20 })
    const later = await createSandboxDomain(owner.id, { expiresInDays: 25 })
    const demo = await createDemoDomain(owner.id, { expiresInDays: 28 })

    // FR-P5: the expiry view renews everything it shows.
    await signIn(page, owner, '/app/domains?within=30')
    await expect(page).toHaveURL(/within=30/)
    await page.waitForLoadState('networkidle')
    await bar(page).getByRole('link', { name: 'Renew all 3 domains' }).click()
    await expect(page).toHaveURL(/\/app\/domains\/renew\?ids=/, { timeout: 30_000 })

    const main = page.getByRole('main')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Renew 2 domains')
    // The demo domain is not in the order, and says why.
    await expect(main.getByRole('list', { name: 'Not in this order' })).toContainText(
      `${demo.name}Demo domains can’t be renewed.`,
    )
    const order = main.getByRole('list', { name: 'Domains to renew' })
    await expect(order.locator('[data-renew-line]')).toHaveCount(2)
    // N8: every line with its renewal price.
    await expect(order.locator(`[data-renew-line="${soon.name}"]`)).toContainText(
      /renews at ₦[\d,]+\/yr/,
    )
    await main.getByLabel('Renew each for').selectOption('2')
    await expect(main).toContainText('Renewals (2 × 2 years)')
    expect((await axe(page)).violations).toEqual([])
    await noOverflowAt320(page)

    await main.getByRole('button', { name: /^Pay / }).click()
    await expect(page.getByRole('heading', { name: 'Mock Flutterwave' })).toBeVisible({
      timeout: 30_000,
    })
    await page.getByRole('link', { name: 'Pay (test)' }).click()
    await expect(page).toHaveURL(/\/app\/orders\/[0-9a-f-]+\?payment=paid$/, { timeout: 30_000 })
    const orderId = new URL(page.url()).pathname.split('/').at(-1) as string

    await expect(main.getByRole('heading', { name: 'Renewals', exact: true })).toBeVisible()
    await expect(main.locator('[data-line-status]')).toHaveText(['Queued', 'Queued'])
    await expect(page.getByText('Your renewals are paid and queued.')).toBeVisible()

    await settleRenewal(orderId, 'renewed')
    await expect(main.locator('[data-line-status]')).toHaveText(['Renewed', 'Renewed'], {
      timeout: 30_000,
    })
    await expect(page.getByText('Every domain in this order is renewed.')).toBeVisible()
    await expect(main).toContainText(later.name)
  })
})

test.describe('nameserver history and revert (FR-N5)', () => {
  let user: TestUser | undefined
  let secret: string

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('ns-revert', { fullName: 'Ada Okafor' })
    secret = await enableTotp(user)
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('every change is listed, and one click asks for the previous set again', async ({
    page,
  }) => {
    const owner = user as TestUser
    const domain = await createDemoDomain(owner.id, { expiresInDays: 90 })
    // Two changes as the registry would record them: the trigger keeps the history.
    await updateTestDomain(domain.id, { nameservers: VERCEL })
    await updateTestDomain(domain.id, { nameservers: NETLIFY })

    await signInWithCode(page, owner, secret, `/app/domains/${domain.name}/nameservers`)
    const history = page.getByRole('region', { name: 'Change history' })
    const changes = history.getByRole('list', { name: 'Nameserver changes' }).getByRole('listitem')
    await expect(changes).toHaveCount(2)
    await expect(changes.first()).toContainText(
      `From ${VERCEL.join(', ')} to ${NETLIFY.join(', ')}`,
    )
    await expect(changes.last()).toContainText('The first set on record for this domain')
    expect((await axe(page)).violations).toEqual([])

    await page.waitForLoadState('networkidle')
    const revert = history.getByRole('button', { name: `Revert to ${VERCEL.join(', ')}` })
    const done = saved(page)
    await revert.click()
    await done
    // The same request as typing the set in: checked in DNS, then saved (a demo never
    // reaches a registry).
    await expect(history.getByRole('status')).toContainText(
      'Saved. This is a demo domain, so nothing is sent to a registry.',
      { timeout: 20_000 },
    )
    await expect(revert).toHaveCount(0)

    await page.reload()
    await expect(
      page.getByText(`Requested: ${VERCEL.join(', ')}. Nothing is sent to a registry.`),
    ).toBeVisible()
    await expect(page.getByRole('region', { name: 'Change history' })).toContainText(
      'has been asked for, and waits to be applied.',
    )
    await page
      .getByRole('navigation', { name: 'Domain' })
      .getByRole('link', { name: 'Activity' })
      .click()
    await expect(page.getByRole('list', { name: 'Activity' })).toContainText(
      `Nameserver change requested: ${VERCEL.join(', ')}`,
    )
  })
})

test.describe('portfolio tools in the dark theme (S3)', () => {
  let user: TestUser | undefined

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('portfolio-dark', { fullName: 'Ada Okafor' })
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('label chips, the bulk bar and its panels pass the same checks in both themes', async ({
    page,
  }) => {
    const owner = user as TestUser
    const first = await createDemoDomain(owner.id, { expiresInDays: 40 })
    await createDemoDomain(owner.id, { expiresInDays: 80 })

    await signIn(page, owner, '/app/settings/labels')
    await page.waitForLoadState('networkidle')
    // One label in every colour, so every token pair is checked for contrast.
    for (const colour of ['Blue', 'Green', 'Amber', 'Red', 'Purple', 'Slate']) {
      const form = page.getByRole('form', { name: 'New label' })
      await form.getByLabel('Label name').fill(`${colour} client`)
      await form.getByText(colour, { exact: true }).click()
      const added = saved(page)
      await form.getByRole('button', { name: 'Add label' }).click()
      await added
      await expect(page.getByRole('list', { name: 'Your labels' })).toContainText(
        `${colour} client`,
      )
    }

    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => localStorage.setItem('theme', value), theme)
      await page.goto('/app/settings/labels')
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/)
      expect((await axe(page)).violations).toEqual([])

      await page.goto('/app/domains')
      await expect(page.getByRole('navigation', { name: 'Labels' })).toBeVisible()
      await tick(page, first.name)
      await bar(page).getByRole('button', { name: 'Labels' }).click()
      await expect(
        page.getByRole('form', { name: 'Labels for the selected domains' }),
      ).toBeVisible()
      expect((await axe(page)).violations).toEqual([])
      await noOverflowAt320(page)
    }
  })
})
