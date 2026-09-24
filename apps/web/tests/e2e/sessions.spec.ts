import AxeBuilder from '@axe-core/playwright'
import { type Browser, expect, type Page, test } from '@playwright/test'
import { createTestUser, deleteTestUser } from './support/accounts.mjs'

/**
 * Active sessions (PRD FR-A5) against the real Supabase project: one test
 * account signed in from several browser contexts, each a separate device.
 *
 * Sign-ins run on one device profile only — Supabase limits sign-ins per
 * address, and other runs share it.
 */

type TestUser = { id: string; email: string; password: string }

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID_FIREFOX = 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0'

async function signIn(page: Page, user: TestUser) {
  await page.goto('/sign-in')
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/app\/domains/)
}

/** Another device: a fresh browser context with its own user agent, signed in. */
async function signInElsewhere(browser: Browser, user: TestUser, userAgent: string) {
  const context = await browser.newContext({ userAgent })
  const page = await context.newPage()
  await signIn(page, user)
  return { context, page }
}

const devices = (page: Page) =>
  page.getByRole('list', { name: 'Signed-in devices' }).getByRole('listitem')

test.describe('active sessions', () => {
  let user: TestUser

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('sessions')
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('lists every device, and signing one out takes its access away', async ({
    page,
    browser,
  }) => {
    await signIn(page, user)
    const phone = await signInElsewhere(browser, user, IPHONE_SAFARI)

    await page.goto('/app/settings#sessions')
    await expect(devices(page)).toHaveCount(2)
    const current = page.locator('li[data-session="current"]')
    await expect(current).toContainText('This device')
    await expect(current).toContainText('Active now')
    // The browser's own user agent, not our server's (FR-A5).
    const other = page.locator('li[data-session="other"]')
    await expect(other).toContainText('Safari on iOS')
    await expect(other).toContainText(/Signed in \d{1,2} \w+ \d{4} · Last seen in the last hour/)

    await other.getByRole('button', { name: 'Sign out Safari on iOS' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'has been signed out' })).toBeVisible()
    await expect(devices(page)).toHaveCount(1)
    await expect(page.getByText('This is the only device signed in.')).toBeVisible()

    // The phone's session is gone, so its next visit to the panel asks it to sign in.
    await phone.page.goto('/app/settings')
    await expect(phone.page).toHaveURL(/\/sign-in/)
    await phone.context.close()
  })

  test('signs every other device out at once, and keeps this one', async ({ page, browser }) => {
    await signIn(page, user)
    const phone = await signInElsewhere(browser, user, IPHONE_SAFARI)
    const tablet = await signInElsewhere(browser, user, ANDROID_FIREFOX)

    await page.goto('/app/settings#sessions')
    await expect(devices(page)).toHaveCount(3)
    await page.getByRole('button', { name: 'Sign out of all other devices' }).click()

    await expect(
      page.getByRole('status').filter({ hasText: 'Every other device has been signed out.' }),
    ).toBeVisible()
    await expect(devices(page)).toHaveCount(1)
    await expect(page.locator('li[data-session="current"]')).toBeVisible()

    // This device is still signed in.
    await page.reload()
    await expect(page).toHaveURL(/\/app\/settings/)
    await phone.context.close()
    await tablet.context.close()
  })

  test('has no detectable accessibility violations and never scrolls sideways', async ({
    page,
    browser,
  }) => {
    await signIn(page, user)
    const phone = await signInElsewhere(browser, user, IPHONE_SAFARI)
    await page.goto('/app/settings#sessions')
    await expect(devices(page)).toHaveCount(2)

    const report = await new AxeBuilder({ page })
      .include('#sessions')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(report.violations).toEqual([])

    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(100)
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      expect(overflows, `horizontal overflow at ${width}px`).toBe(false)
    }
    await phone.context.close()
  })
})
