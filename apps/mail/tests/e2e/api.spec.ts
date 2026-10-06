import AxeBuilder from '@axe-core/playwright'
import { expect as baseExpect, type Page, test } from '@playwright/test'
import { createTestUser, deleteTestUser, type TestUser } from './support/accounts'
import { type ReadyAccount, readyAccount, workAsSender } from './support/mail-api'

/**
 * MAIL-SPEC §6, §10, §12 against the real Supabase project (migrations
 * 43–48): a key made in the dashboard → an email sent through the API →
 * the worker's part played by SQL (no SES) → the email seen in the log and on
 * its own page → a scheduled email moved and canceled → the key revoked.
 * Every page with axe in both themes and no sideways scroll at any width.
 *
 * The account is an e2e account in the sandbox, so it sends only to its own
 * member, and its domain is under the reserved `.example` TLD. Sign-in runs
 * on two projects only: Supabase limits sign-ins per address.
 */

const SIGN_IN_PROJECTS = ['chromium-desktop', 'mobile-ios']
const expect = baseExpect.configure({ timeout: 30_000 })
test.use({ reducedMotion: 'reduce' })
const WIDTHS = [320, 375, 414, 768, 1024, 1440, 1920]

async function checkPage(page: Page, only?: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    const builder = new AxeBuilder({ page }).withTags([
      'wcag2a',
      'wcag2aa',
      'wcag21a',
      'wcag21aa',
      'wcag22aa',
    ])
    const results = await (only ? builder.include(only) : builder).analyze()
    expect(results.violations).toEqual([])
  }
  await page.emulateMedia({ colorScheme: 'light' })
  const original = page.viewportSize()
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0)
  }
  if (original) await page.setViewportSize(original)
}

async function signIn(page: Page, user: TestUser, next: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${next.replace(/[?]/g, '\\?')}$`))
}

test.describe('the v1 API, from a key to the log', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 })
  let owner: TestUser
  let account: ReadyAccount
  let key = ''
  let sentId = ''
  const stamp = `j${Date.now().toString(36)}`

  test.beforeAll(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    owner = await createTestUser('api', 'Ada Developer')
    account = await readyAccount(owner, `API e2e ${stamp}`)
  })

  test.afterAll(async () => {
    if (owner) await deleteTestUser(owner)
  })

  test.beforeEach(() => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
  })

  const api = (page: Page) => ({
    send: (body: unknown, headers: Record<string, string> = {}) =>
      page.request.post('/api/v1/emails', {
        headers: { authorization: `Bearer ${key}`, ...headers },
        data: body,
      }),
    get: (path: string) =>
      page.request.get(`/api/v1${path}`, { headers: { authorization: `Bearer ${key}` } }),
    post: (path: string, body?: unknown) =>
      page.request.post(`/api/v1${path}`, {
        headers: { authorization: `Bearer ${key}` },
        ...(body === undefined ? {} : { data: body }),
      }),
    patch: (path: string, body: unknown) =>
      page.request.patch(`/api/v1${path}`, {
        headers: { authorization: `Bearer ${key}` },
        data: body,
      }),
  })

  const email = (over: Record<string, unknown> = {}) => ({
    from: `E2E <hello@${account.domain}>`,
    to: [owner.email],
    subject: `Your receipt ${stamp}`,
    html: `<p>Thanks, ${stamp}.</p>`,
    text: `Thanks, ${stamp}.`,
    tags: [{ name: 'journey', value: stamp }],
    ...over,
  })

  test('a key made in the dashboard is shown once, then listed (MR7)', async ({ page }) => {
    await signIn(page, owner, '/dashboard/api-keys')
    await expect(page.getByRole('heading', { name: 'API keys', level: 1 })).toBeVisible()
    await expect(page.getByText('No keys yet')).toBeVisible()
    await checkPage(page)

    const form = page.getByRole('form', { name: 'Make an API key' })
    await form.getByLabel('Name').fill('E2E journey')
    await form.getByRole('radio', { name: /Full access/ }).check()
    await form.getByRole('button', { name: 'Make the key' }).click()

    const secret = page.getByLabel('Your API key')
    await expect(secret).toHaveValue(/^mdh_live_[A-Za-z0-9]{40}$/)
    key = await secret.inputValue()
    const done = page.getByRole('button', { name: 'Done' })
    await expect(done).toBeDisabled()
    await checkPage(page)
    await page.getByRole('checkbox', { name: 'I have saved it' }).check()
    await done.click()

    await expect(secret).toHaveCount(0)
    const row = page.locator(`[data-key="${key.slice(0, 13)}"]`)
    await expect(row).toContainText('E2E journey')
    await expect(row).toContainText('Full access')
    await expect(row).toContainText('never used')
    // The key itself is nowhere on the page any more.
    await expect(page.locator('body')).not.toContainText(key)
  })

  test('an email sent through the API, sent by the worker, is in the log (§6, §10)', async ({
    page,
  }) => {
    const first = await api(page).send(email(), { 'idempotency-key': `receipt-${stamp}` })
    expect(first.status()).toBe(200)
    expect(first.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    sentId = ((await first.json()) as { id: string }).id
    const again = await api(page).send(email(), { 'idempotency-key': `receipt-${stamp}` })
    expect(await again.json()).toEqual({ id: sentId })

    const refused = await api(page).send(email({ to: ['someone-else@example.com'] }))
    expect(refused.status()).toBe(403)
    expect(await refused.json()).toMatchObject({ name: 'forbidden' })

    await workAsSender(account.accountId, sentId)
    const read = await api(page).get(`/emails/${sentId}`)
    expect(await read.json()).toMatchObject({
      object: 'email',
      id: sentId,
      status: 'delivered',
      last_event: 'delivery',
    })
    const listed = await api(page).get(`/emails?tag=journey:${stamp}&status=delivered`)
    const list = (await listed.json()) as { data: { id: string }[]; has_more: boolean }
    expect(list.data.map((row) => row.id)).toEqual([sentId])

    await signIn(page, owner, '/dashboard/emails')
    const row = page.locator(`[data-email="${sentId}"]`)
    await expect(row).toContainText(`Your receipt ${stamp}`)
    await expect(row).toContainText('Delivered')
    await checkPage(page)

    // Search by the exact recipient, then open the email.
    await page.getByLabel('Recipient').fill(owner.email)
    await page.getByRole('button', { name: 'Search' }).click()
    await expect(page).toHaveURL(/to=/)
    await expect(row).toBeVisible()
    await row.getByRole('link').click()
    await expect(
      page.getByRole('heading', { name: `Your receipt ${stamp}`, level: 1 }),
    ).toBeVisible()
    const timeline = page.getByRole('region', { name: 'What happened' })
    for (const step of ['Queued', 'Sent', 'Delivered']) {
      await expect(timeline.locator(`[data-event="${step}"]`)).toBeVisible()
    }
    await expect(page.getByRole('region', { name: 'Headers' })).toContainText(
      `From:E2E <hello@${account.domain}>`,
    )
    await expect(page.getByText(/Kept until .*, then deleted within the hour\./)).toBeVisible()
    await expect(page.getByRole('region', { name: 'The text body' })).toContainText(stamp)
    await checkPage(page)
  })

  test('a scheduled email is moved, then canceled, and the log says so (§3.1)', async ({
    page,
  }) => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const queued = await api(page).send(email({ subject: `Later ${stamp}`, scheduled_at: later }))
    expect(queued.status()).toBe(200)
    const { id } = (await queued.json()) as { id: string }
    expect(await (await api(page).get(`/emails/${id}`)).json()).toMatchObject({ status: 'queued' })

    const moved = await api(page).patch(`/emails/${id}`, {
      scheduled_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    })
    expect(moved.status()).toBe(200)
    const canceled = await api(page).post(`/emails/${id}/cancel`)
    expect(await canceled.json()).toMatchObject({ object: 'email', id, status: 'canceled' })
    expect((await api(page).post(`/emails/${id}/cancel`)).status()).toBe(200)
    const tooLate = await api(page).patch(`/emails/${id}`, { scheduled_at: later })
    expect(tooLate.status()).toBe(409)
    expect(await (await api(page).get(`/emails/${id}`)).json()).toMatchObject({
      status: 'canceled',
      canceled_at: expect.any(String),
    })
    // The email the worker sent can no longer be canceled.
    expect((await api(page).post(`/emails/${sentId}/cancel`)).status()).toBe(409)

    await signIn(page, owner, '/dashboard/emails?status=canceled')
    const row = page.locator(`[data-email="${id}"]`)
    await expect(row).toContainText('Canceled')
    await row.getByRole('link').click()
    await expect(page.getByText('Its body was deleted when it was canceled.')).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'What happened' }).locator('[data-event="Canceled"]'),
    ).toBeVisible()
    await checkPage(page)
  })

  test('a batch queues all or none, and the API describes itself', async ({ page }) => {
    const batch = await api(page).post('/emails/batch', [
      email({ subject: `Batch one ${stamp}` }),
      email({ subject: `Batch two ${stamp}` }),
    ])
    expect(batch.status()).toBe(200)
    expect(((await batch.json()) as { data: unknown[] }).data).toHaveLength(2)
    const refused = await api(page).post('/emails/batch', [
      email(),
      email({ from: 'someone@not-ours.example' }),
    ])
    expect(refused.status()).toBe(403)
    expect(((await refused.json()) as { message: string }).message).toMatch(/^emails\[1\]: /)

    const unknown = await api(page).get('/nothing-here')
    expect(unknown.status()).toBe(404)
    expect(unknown.headers()['x-request-id']).toBeTruthy()
    const doc = await page.request.get('/api/v1/openapi.json')
    expect(doc.status()).toBe(200)
    expect(await doc.json()).toMatchObject({ openapi: '3.1.0' })
  })

  test('revoking the key, after a confirmation, closes the API to it', async ({ page }) => {
    await signIn(page, owner, '/dashboard/api-keys')
    const row = page.locator(`[data-key="${key.slice(0, 13)}"]`)
    await expect(row).toContainText(/last used/)
    await row.getByRole('button', { name: 'Revoke the key E2E journey' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('are refused from now on')
    await checkPage(page, '[role="alertdialog"]')
    await dialog.getByRole('button', { name: 'Revoke the key' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Revoked keys' })).toBeVisible()
    const after = await api(page).get(`/emails/${sentId}`)
    expect(after.status()).toBe(401)
  })
})
