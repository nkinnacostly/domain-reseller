import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createAdminTestUser,
  createSandboxDomain,
  deleteTestUser,
  hasAdminSchema,
  updateTestDomain,
} from './support/accounts.mjs'
import { type AdminUser, expect, SIGN_IN_PROJECTS, signInAsAdmin, test } from './support/admin'

/**
 * Domains (docs/ADMIN-SPEC.md §5.2 B9, §9): the list's filters; the detail's
 * "Ours vs Registry" diff from the mock gateway's registry read; registrant
 * verification from the mock; the registrant's summary shown and the rest
 * hidden until an audited reveal — and gone once the page is left; "Queue a
 * deep sync" refused with the NO_GATEWAY words or queued, as the
 * `gateway:ote` heartbeat read first says. A test-only admin, on the test
 * side, with no failure artifacts (support/admin.ts).
 *
 * Seeds are test-mode domains of the admin's own e2e account
 * (createSandboxDomain), so SQL's reserved_target lets a test admin reveal
 * their registrant. The account's deletion removes them.
 */

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

/** A registrant only this test knows: nothing of it may show before the reveal. */
function registrantFor(stamp: string) {
  return {
    firstName: 'Adaeze',
    lastName: `Registrant${stamp}`,
    email: `registrant-${stamp}@example.net`,
    phoneCountryCode: '234',
    phone: '8030000000',
    addressLine1: '1 Marina Road',
    city: 'Lagos',
    state: 'Lagos',
    zipCode: '100001',
    country: 'NG',
  }
}

async function auditRows(domainId: string, action: string) {
  const { data } = await service()
    .from('admin_audit_log')
    .select('outcome, error_code')
    .eq('target_id', domainId)
    .eq('action', action)
  return data ?? []
}

async function deepCheckedAt(domainId: string): Promise<string | null> {
  const { data } = await service()
    .from('domains')
    .select('deep_checked_at')
    .eq('id', domainId)
    .single()
  return data?.deep_checked_at ?? null
}

/** Minutes since the sandbox gateway's last heartbeat, or null when it never beat. */
async function sandboxGatewayAge(): Promise<number | null> {
  const { data } = await service()
    .from('service_heartbeats')
    .select('beat_at')
    .eq('name', 'gateway:ote')
    .maybeSingle()
  if (!data?.beat_at) return null
  return (Date.now() - Date.parse(data.beat_at)) / 60_000
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

/** No horizontal overflow from 320 to 1920 px; the project's own viewport is put back after. */
async function expectNoOverflow(page: Page) {
  const original = page.viewportSize()
  for (const width of [320, 375, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `overflow at ${width}`).toBeLessThanOrEqual(1)
  }
  if (original) await page.setViewportSize(original)
}

test.describe('domains to anyone who is not an admin', () => {
  test('every domains page is the plain 404', async ({ page }) => {
    for (const path of ['/admin/domains', '/admin/domains/00000000-0000-4000-8000-000000000000']) {
      const response = await page.goto(path)
      expect(response?.status(), path).toBe(404)
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Domains' })).toHaveCount(0)
    }
  })
})

test.describe('domains to a test administrator', () => {
  let admin: AdminUser | undefined

  test.beforeEach(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    test.skip(!(await hasAdminSchema()), 'migrations 40–41 are not applied to this database')
    admin = (await createAdminTestUser('domains')) as AdminUser
  })
  test.afterEach(async () => {
    if (admin) await deleteTestUser(admin.user.id)
    admin = undefined
  })

  test('the list filters by the URL, and the detail sets ours beside the registry', async ({
    page,
  }) => {
    if (!admin) throw new Error('no admin')
    const soon = await createSandboxDomain(admin.user.id, { expiresInDays: 20 })
    const later = await createSandboxDomain(admin.user.id, { expiresInDays: 200 })

    await signInAsAdmin(page, admin, '/admin/domains')
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { level: 1, name: 'Domains' })).toBeVisible()
    await expect(
      page.locator('nav[aria-label="Admin"] a[href="/admin/domains"]').first(),
    ).toHaveAttribute('aria-current', 'page')
    await expect(main.getByRole('region', { name: 'At a glance' })).toBeVisible()
    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)

    // The search box is a GET form: the domain is in the URL, never an email.
    const search = main.getByRole('searchbox', { name: 'Search domains' })
    await search.fill(soon.name)
    await search.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/admin/domains\\?q=${soon.name}$`))
    await expect(main.getByRole('heading', { level: 2, name: '1 domain' })).toBeVisible()
    await expect(main.getByRole('link', { name: soon.name })).toBeVisible()

    // A status chip keeps the search.
    await main
      .getByRole('navigation', { name: 'Domain status' })
      .getByRole('link', { name: 'Active', exact: true })
      .click()
    await expect(page).toHaveURL(new RegExp(`status=active&q=${soon.name}$`))
    await expect(main.getByRole('link', { name: soon.name })).toBeVisible()

    // The filter form: expiring within 30 days holds one of the two, not the other.
    const filters = main.getByRole('form', { name: 'Filter domains' })
    await filters.getByLabel('Expiry').selectOption('30')
    await filters.getByRole('button', { name: 'Apply filters' }).click()
    await expect(page).toHaveURL(/expires=30/)
    await expect(main.getByRole('link', { name: soon.name })).toBeVisible()
    await page.goto(`/admin/domains?status=active&expires=30&q=${later.name}`)
    await expect(main.getByText('No domains match these filters.')).toBeVisible()
    await page.goto(`/admin/domains?expires=90&q=${later.name}`)
    await expect(main.getByText('No domains match these filters.')).toBeVisible()
    await page.goto(`/admin/domains?q=${later.name}&sort=name`)
    await expect(main.getByRole('link', { name: later.name })).toBeVisible()

    // The detail: our record beside what the hourly check stored, until a read.
    await page.goto(`/admin/domains?q=${soon.name}`)
    await main.getByRole('link', { name: soon.name }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/domains/${soon.id}$`))
    await expect(main.getByRole('heading', { level: 1, name: soon.name })).toBeVisible()
    const registry = main.getByRole('region', { name: 'Ours and the registry' })
    await expect(
      registry.getByRole('row', { name: /Status\s+Active\s+Not read yet\s+Same/ }),
    ).toBeVisible()
    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)

    // The mock gateway answers "not in our account": the diff says so, and that it differs.
    await registry.getByRole('button', { name: 'Read the registry now' }).click()
    await expect(registry.getByRole('status')).toHaveText(/^1 field differs\./)
    await expect(
      registry.getByRole('row', { name: /Status\s+Active\s+Not in our account\s+Differs/ }),
    ).toBeVisible()
    await expect(
      registry.getByText('Our record beside the registry, read at 12:05 WAT.'),
    ).toBeVisible()
    // The read is audited: an intent note the gateway claimed (D22).
    const reads = await service()
      .from('admin_audit_log')
      .select('outcome')
      .eq('action', 'supplier.domain_lookup')
      .eq('admin_label', admin.label)
    expect((reads.data ?? []).some((row) => row.outcome === 'intent')).toBe(true)
  })

  test('verification comes from the mock; the registrant is hidden until revealed, and gone once the page is left', async ({
    page,
  }) => {
    if (!admin) throw new Error('no admin')
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const domain = await createSandboxDomain(admin.user.id)
    const person = registrantFor(stamp)
    await updateTestDomain(domain.id, { registrant: person })

    await signInAsAdmin(page, admin, `/admin/domains/${domain.id}`)
    const main = page.getByRole('main')
    const panel = main.getByRole('region', { name: 'Registrant' })
    // The summary, from the masked view.
    await expect(panel.getByText('Nigeria (NG)')).toBeVisible()
    await expect(panel.getByText('Individual')).toBeVisible()
    // The rest is nowhere on the page.
    await expect(page.getByText(person.email)).toHaveCount(0)
    await expect(page.getByText(person.lastName, { exact: false })).toHaveCount(0)
    expect(await page.content()).not.toContain(person.email)

    // Verification, read live from the mock gateway.
    await panel.getByRole('button', { name: 'Read registrant verification' }).click()
    await expect(panel.getByRole('status').filter({ hasText: 'Read at' })).toHaveText(
      'Read at 12:05 WAT: verified (Email)',
    )

    // The reveal: asked, audited, shown on the page.
    await panel.getByRole('button', { name: 'Show registrant' }).click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', { name: `Show the registrant of ${domain.name}?` }),
    ).toBeVisible()
    await expect(dialog).toContainText('Your view is recorded in the audit log.')
    await dialog.getByLabel('Reason (optional)').fill('e2e: the customer asked for a copy')
    await dialog.getByRole('button', { name: 'Show registrant' }).click()
    await expect(
      dialog.getByText('Shown below. Your view is recorded in the audit log.'),
    ).toBeVisible()
    expect((await axe(page)).violations).toEqual([])
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(panel.getByText(person.email)).toBeVisible()
    await expect(panel.getByText(`Adaeze ${person.lastName}`)).toBeVisible()
    await expect
      .poll(async () =>
        (await auditRows(domain.id, 'domain.reveal_contacts')).map((r) => r.outcome),
      )
      .toEqual(['ok'])
    expect((await axe(page)).violations).toEqual([])

    // Leaving clears it: back on the page, the details are gone.
    await main
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Domains', exact: true })
      .click()
    await expect(main.getByRole('heading', { level: 1, name: 'Domains' })).toBeVisible()
    await page.goBack()
    await expect(main.getByRole('heading', { level: 1, name: domain.name })).toBeVisible()
    await expect(
      main.getByRole('region', { name: 'Registrant' }).getByText('Nigeria (NG)'),
    ).toBeVisible()
    await expect(page.getByText(person.email)).toHaveCount(0)
  })

  test('Queue a deep sync says NO_GATEWAY, or queues it, as the sandbox gateway’s heartbeat says', async ({
    page,
  }) => {
    if (!admin) throw new Error('no admin')
    const domain = await createSandboxDomain(admin.user.id)
    const checkedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    await updateTestDomain(domain.id, { deep_checked_at: checkedAt })

    await signInAsAdmin(page, admin, `/admin/domains/${domain.id}`)
    const sync = page.getByRole('main').getByRole('region', { name: 'Deep sync' })
    await expect(sync.getByText(/^Last read by the deep sync /)).toBeVisible()
    // service_heartbeats has no side: a test administrator is not shown it (§2.3).
    await expect(
      sync.getByText(
        'Whether a gateway is reading this side is not shown to test administrators; the database checks it when you queue.',
      ),
    ).toBeVisible()

    // The heartbeat the spec reads first decides what to expect (the rule is 15 minutes).
    const age = await sandboxGatewayAge()
    const reading = age !== null && age < 14
    const near = age !== null && age >= 14 && age <= 16

    await sync.getByRole('button', { name: 'Queue a deep sync' }).click()
    const dialog = page.getByRole('dialog')
    await expect(
      dialog.getByRole('heading', {
        name: `Read ${domain.name} from the registry on the next sync?`,
      }),
    ).toBeVisible()
    await expect(dialog).toContainText(
      'The next deep sync, within an hour, reads it and corrects our record from the registry. Nothing changes at the registry.',
    )
    await dialog.getByRole('button', { name: 'Queue a deep sync' }).click()

    const queued = dialog.getByText('Queued: the next deep sync reads it within an hour.')
    const refused = dialog.getByText(
      'No gateway is reading this side right now, so nothing would read it.',
    )
    await expect(queued.or(refused)).toBeVisible()
    const rows = await auditRows(domain.id, 'domain.deep_sync')
    if (near) {
      expect(rows).toHaveLength(1)
    } else if (reading) {
      await expect(queued).toBeVisible()
      expect(rows).toEqual([{ outcome: 'ok', error_code: null }])
      expect(await deepCheckedAt(domain.id)).toBeNull()
    } else {
      await expect(refused).toBeVisible()
      expect(rows).toEqual([{ outcome: 'refused', error_code: 'NO_GATEWAY' }])
      expect(Date.parse((await deepCheckedAt(domain.id)) ?? '')).toBe(Date.parse(checkedAt))
    }
    await dialog
      .getByRole('button', { name: 'Close' })
      .or(dialog.getByRole('button', { name: 'Not now' }))
      .click()
    expect((await axe(page)).violations).toEqual([])

    await test.step('Dark theme: the domain page passes axe too (S3, S8)', async () => {
      await page.evaluate(() => localStorage.setItem('theme', 'dark'))
      await page.reload()
      await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      expect((await axe(page)).violations).toEqual([])
      await page.goto('/admin/domains')
      await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      expect((await axe(page)).violations).toEqual([])
      await page.evaluate(() => localStorage.removeItem('theme'))
    })
  })
})
