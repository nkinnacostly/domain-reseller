import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { createTestUser, deleteTestUser, hasAccount } from './support/accounts.mjs'

/**
 * Bot protection (PRD SEC-9). The server runs with Cloudflare's always-pass
 * Turnstile test keys (playwright.config.ts): the real widget, out of sight
 * because the test key needs no click, and a real siteverify call that says
 * yes. Blocking challenges.cloudflare.com stands in for a check that never
 * loads — the only way to see a refusal with keys that always pass.
 *
 * Nothing here sends an email: sign-up uses an address that already has a
 * confirmed account (Supabase answers as for a new one, and sends nothing),
 * and the link forms use addresses with no account.
 */

const CLOUDFLARE = 'https://challenges.cloudflare.com/**'
const SIGN_IN_PROJECTS = ['chromium-desktop', 'mobile-ios']

const testAddress = () =>
  `198.18.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
const nobody = () =>
  `e2e-nobody-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

async function expectNoOverflow(page: Page, widths = [320, 375, 1440]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(100)
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    expect(overflows, `horizontal overflow at ${width}px`).toBe(false)
  }
}

/** The widget has handed its token to the form — a person takes this long to type. */
async function tokenReady(page: Page) {
  await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue('', {
    timeout: 15_000,
  })
}

test.describe('forms that send email (SEC-9)', () => {
  test.beforeEach(() => {
    // Supabase limits sign-ups and sign-in links per address; two devices are enough.
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
  })

  test('sign-up passes the check with the test key, and answers as it always has', async ({
    page,
  }) => {
    // Already confirmed: Supabase gives the same answer as a new sign-up and sends nothing.
    const user = await createTestUser('turnstile-signup')
    try {
      const response = await page.goto('/sign-up')
      expect(response?.headers()['content-security-policy']).toContain(
        'frame-src https://challenges.cloudflare.com',
      )
      const form = page.getByRole('form', { name: 'Create an account' })
      await form.getByLabel('Your name').fill('Ada Okafor')
      await form.getByLabel('Email').fill(user.email)
      await form.getByLabel('Password', { exact: true }).fill('long-enough-password')
      await tokenReady(page)
      await form.getByRole('button', { name: 'Create account' }).click()

      await expect(page.getByText('Check your email')).toBeVisible()
      await expect(page.getByText(`We sent a confirmation link to ${user.email}`)).toBeVisible()
    } finally {
      await deleteTestUser(user.id)
    }
  })

  test('a sign-up whose check never loaded is refused, and no account is made', async ({
    page,
  }) => {
    await page.route(CLOUDFLARE, (route) => route.abort())
    const email = nobody()
    await page.goto('/sign-up')
    const form = page.getByRole('form', { name: 'Create an account' })
    await form.getByLabel('Your name').fill('Ada Okafor')
    await form.getByLabel('Email').fill(email)
    await form.getByLabel('Password', { exact: true }).fill('long-enough-password')
    await form.getByRole('button', { name: 'Create account' }).click()

    await expect(form.getByRole('alert')).toHaveText(
      "We couldn't confirm you're a person. Try again.",
    )
    await expect(form.getByLabel('Email')).toHaveValue(email)
    expect(await hasAccount(email)).toBe(false)
  })

  test('the sign-in link and a password reset pass the check', async ({ page }) => {
    await page.goto('/sign-in')
    await page.getByRole('button', { name: 'Email me a sign-in link instead' }).click()
    const link = page.getByRole('form', { name: 'Email me a sign-in link' })
    const first = nobody()
    await link.getByLabel('Email').fill(first)
    await tokenReady(page)
    await link.getByRole('button', { name: 'Email me a link' }).click()
    await expect(
      page.getByText(`If ${first} has an account, a sign-in link is on its way.`),
    ).toBeVisible()

    await page.goto('/forgot-password')
    const reset = page.getByRole('form', { name: 'Reset your password' })
    const second = nobody()
    await reset.getByLabel('Email').fill(second)
    await tokenReady(page)
    await reset.getByRole('button', { name: 'Email me a reset link' }).click()
    await expect(page.getByText(`If ${second} has an account`)).toBeVisible()
  })

  test('the forms with a check fit a phone and pass axe', async ({ page }) => {
    for (const path of ['/sign-up', '/forgot-password']) {
      await page.goto(path)
      await tokenReady(page)
      expect((await axe(page)).violations, path).toEqual([])
      await expectNoOverflow(page)
      await page.setViewportSize({ width: 1280, height: 900 })
    }
  })
})

test.describe('search past the free allowance (SEC-9)', () => {
  const exact = (page: Page) => page.locator('article[aria-labelledby="exact-domain"]')
  const check = (page: Page) =>
    page.getByRole('region', { name: 'Confirm you’re a person to keep searching' })

  test('asks for the check instead of searching, and passing it shows the results', async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(120_000)
    const address = testAddress()
    await context.setExtraHTTPHeaders({ 'x-real-ip': address })

    // Counts sit in ten-minute windows: do not start in the last seconds of one.
    const into = (Date.now() / 1000) % 600
    if (into > 560) await page.waitForTimeout((605 - into) * 1000)

    // Search from this address, as a script would, until the allowance runs out.
    let challenged = false
    for (let round = 0; round < 12 && !challenged; round += 1) {
      const bodies = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const response = await request.get(`/search?q=allowance${round}x${index}`, {
            headers: { 'x-real-ip': address },
          })
          return response.text()
        }),
      )
      challenged = bodies.some((body) => body.includes('Confirm you’re a person to keep searching'))
    }
    expect(challenged, 'the free allowance ran out').toBe(true)

    // A check that cannot load stays on screen, in place of the results.
    await page.route(CLOUDFLARE, (route) => route.abort())
    await page.goto('/search?q=getpaid')
    await expect(check(page)).toBeVisible()
    await expect(check(page).getByRole('alert')).toContainText("The check didn't load")
    await expect(exact(page)).toHaveCount(0)
    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)
    await page.setViewportSize({ width: 1280, height: 900 })

    // Once Cloudflare answers, the test key passes without a click.
    await page.unroute(CLOUDFLARE)
    await check(page).getByRole('button', { name: 'Try again' }).click()
    await expect(exact(page).getByRole('heading')).toHaveText('getpaid.com')
    await expect(check(page)).toHaveCount(0)

    const pass = (await context.cookies()).find((cookie) => cookie.name === 'dr_search_pass')
    expect(pass).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/search' })
    const hoursLeft = ((pass?.expires ?? 0) - Date.now() / 1000) / 3600
    expect(hoursLeft).toBeGreaterThan(1.9)
    expect(hoursLeft).toBeLessThanOrEqual(2.01)

    // With the pass, the next search goes straight through.
    await page.goto('/search?q=takenbrand')
    await expect(exact(page).getByRole('heading')).toHaveText('takenbrand.com')
  })
})

test.describe('bulk search (SEC-9)', () => {
  const check = (page: Page) =>
    page.getByRole('region', { name: 'Confirm you’re a person to check this list' })
  const summary = (page: Page) => page.locator('section[aria-labelledby="bulk-summary"]')

  test('asks for the check before a list starts, then checks it', async ({ page, context }) => {
    await context.setExtraHTTPHeaders({ 'x-real-ip': testAddress() })
    await page.route(CLOUDFLARE, (route) => route.abort())
    await page.goto('/search/bulk')
    await page.locator('form[data-enhanced="true"]').waitFor()
    const form = page.getByRole('form', { name: 'Bulk search' })
    await form.getByLabel('Names to check').fill('getpaid\ntakenbrand')
    await form.getByRole('button', { name: 'Check names' }).click()

    await expect(check(page)).toBeVisible()
    await expect(check(page).getByRole('alert')).toContainText("The check didn't load")
    await expect(form.getByRole('button', { name: /Checking/ })).toBeDisabled()
    expect((await axe(page)).violations).toEqual([])
    await expectNoOverflow(page)
    await page.setViewportSize({ width: 1280, height: 900 })

    await page.unroute(CLOUDFLARE)
    await check(page).getByRole('button', { name: 'Try again' }).click()

    await expect(check(page)).toHaveCount(0)
    await expect(summary(page).getByRole('heading', { level: 2 })).toHaveText('1 of 2 available')
    expect((await context.cookies()).some((cookie) => cookie.name === 'dr_search_pass')).toBe(true)
  })
})

test.describe('privacy notice (SEC-9, N9b)', () => {
  test('names Cloudflare Turnstile and the search pass cookie while the check is on', async ({
    page,
  }) => {
    await page.goto('/legal/privacy')
    const share = page.getByRole('region', { name: 'Who receives it', exact: true })
    await expect(
      share.getByRole('listitem').filter({ hasText: 'Cloudflare Turnstile' }),
    ).toContainText('It sees your IP address and signals from your browser (United States).')
    const cookies = page.getByRole('region', { name: 'Cookies', exact: true })
    await expect(cookies.getByRole('listitem').filter({ hasText: 'dr_search_pass' })).toContainText(
      'Lasts 2 hours.',
    )
  })
})
