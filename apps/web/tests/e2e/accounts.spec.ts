import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import {
  createTestUser,
  deleteTestUser,
  freshTotpCode,
  setPasswordResetAt,
} from './support/accounts.mjs'

/**
 * Accounts (PRD E2) against the real Supabase project.
 *
 * Test users are created confirmed through the admin API, so nothing here
 * sends an email. Flows that sign in run on two projects only: Supabase rate
 * limits sign-ins per IP, and five device profiles would exhaust it.
 */

type TestUser = { id: string; email: string; password: string }

const SIGN_IN_PROJECTS = ['chromium-desktop', 'mobile-ios']

/** Sign-out lives in the account menu, in the sidebar — a drawer on phones. */
async function signOutFromPanel(page: Page) {
  const drawer = page.getByRole('button', { name: 'Open menu' })
  const account = page.getByRole('button', { name: 'Account menu' })
  // The drawer and the menu open once the page has hydrated: keep trying.
  await expect(async () => {
    if (!(await account.isVisible())) await drawer.click({ timeout: 1_000 })
    await account.click({ timeout: 1_000 })
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
}

async function signIn(page: Page, user: TestUser, path = '/sign-in') {
  await page.goto(path)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

test.describe('signed out', () => {
  test('the panel sends you to sign in, and remembers where you were going', async ({ page }) => {
    await page.goto('/app/settings')
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%2Fsettings$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in')
  })

  test('pages that need a session send you to the right place', async ({ page }) => {
    await page.goto('/verify')
    await expect(page).toHaveURL(/\/sign-in$/)
    await page.goto('/reset-password')
    await expect(page).toHaveURL(/\/forgot-password\?error=expired$/)
    await expect(page.getByText('That reset link has expired')).toBeVisible()
  })

  test('a dead email link explains itself', async ({ page }) => {
    await page.goto('/auth/callback?flow=magiclink&error_code=otp_expired')
    await expect(page).toHaveURL(/\/sign-in\?error=expired$/)
    await expect(page.getByText('That link has expired or was already used')).toBeVisible()
  })

  test('sign-up checks the form before creating anything', async ({ page }) => {
    await page.goto('/sign-up')
    const form = page.getByRole('form', { name: 'Create an account' })
    await form.getByLabel('Your name').fill('Ada Okafor')
    await form.getByLabel('Email').fill('not-an-email')
    await form.getByLabel('Password', { exact: true }).fill('short')
    await form.getByRole('button', { name: 'Create account' }).click()

    await expect(form.getByText('Enter a valid email address')).toBeVisible()
    await expect(form.getByText('Use at least 10 characters')).toBeVisible()
    await expect(form.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true')
    // Nothing typed is lost to the error.
    await expect(form.getByLabel('Your name')).toHaveValue('Ada Okafor')
  })

  test('the password field can be shown and hidden', async ({ page }) => {
    await page.goto('/sign-in')
    const field = page.getByLabel('Password', { exact: true })
    await expect(field).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: 'Show password' }).click()
    await expect(field).toHaveAttribute('type', 'text')
    await expect(page.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  test('offers a sign-in link instead of a password', async ({ page }) => {
    await page.goto('/sign-in')
    await page.getByRole('button', { name: 'Email me a sign-in link instead' }).click()
    await expect(page.getByRole('form', { name: 'Email me a sign-in link' })).toBeVisible()
  })

  for (const path of ['/sign-in', '/sign-up', '/forgot-password']) {
    test(`${path} has no accessibility violations and never scrolls sideways`, async ({ page }) => {
      await page.goto(path)
      expect((await axe(page)).violations).toEqual([])
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        )
        expect(overflows, `overflow at ${width}px`).toBe(false)
      }
    })
  }
})

test.describe('signed in', () => {
  let user: TestUser

  test.beforeEach(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    user = await createTestUser('account')
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('a wrong password says so and keeps the email', async ({ page }) => {
    await signIn(page, { ...user, password: 'not-the-password-1' })
    const form = page.getByRole('form', { name: 'Sign in', exact: true })
    await expect(form.getByRole('alert')).toContainText("don't match an account")
    await expect(form.getByLabel('Email')).toHaveValue(user.email)
  })

  test('signing in returns you to the page you asked for, and out again', async ({ page }) => {
    await page.goto('/app/settings')
    await expect(page).toHaveURL(/\/sign-in/)
    const form = page.getByRole('form', { name: 'Sign in', exact: true })
    await form.getByLabel('Email').fill(user.email)
    await form.getByLabel('Password', { exact: true }).fill(user.password)
    await form.getByRole('button', { name: 'Sign in', exact: true }).click()

    await expect(page).toHaveURL(/\/app\/settings$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings')

    // Signed-in people are sent past the sign-in page.
    await page.goto('/sign-in')
    await expect(page).toHaveURL(/\/app\/domains$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /^Good (morning|afternoon|evening), Test$/,
    )

    // The marketing header knows, after hydration. On phones the link is in the menu.
    await page.goto('/pricing')
    const menu = page.getByRole('button', { name: 'Open menu' })
    if (await menu.isVisible()) await menu.click()
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'Your domains' }).first(),
    ).toBeVisible()

    await page.goto('/app/domains')
    await signOutFromPanel(page)
    await expect(page).toHaveURL(/\/$/)
    await page.goto('/app/domains')
    await expect(page).toHaveURL(/\/sign-in/)
  })

  test('the panel has no accessibility violations', async ({ page }) => {
    await signIn(page, user, '/sign-in?next=%2Fapp%2Fsettings')
    await expect(page).toHaveURL(/\/app\/settings$/)
    expect((await axe(page)).violations).toEqual([])
    await page.goto('/app/domains')
    await expect(page.getByRole('heading', { name: 'No domains yet' })).toBeVisible()
    expect((await axe(page)).violations).toEqual([])
  })

  test('profile changes are saved', async ({ page }) => {
    await signIn(page, user, '/sign-in?next=%2Fapp%2Fsettings')
    const form = page.getByRole('form', { name: 'Profile' })
    await form.getByLabel('Name').fill('Ada Okafor')
    await form.getByLabel('Phone (optional)').fill('+234 803 123 4567')
    await form.getByRole('button', { name: 'Save profile' }).click()
    await expect(form.getByRole('status')).toHaveText('Saved.')

    await page.reload()
    await expect(page.getByRole('form', { name: 'Profile' }).getByLabel('Name')).toHaveValue(
      'Ada Okafor',
    )
  })

  test('changing the password needs the current one', async ({ page }) => {
    await signIn(page, user, '/sign-in?next=%2Fapp%2Fsettings')
    const form = page.getByRole('form', { name: 'Change password' })
    await form.getByLabel('Current password').fill('not-my-password')
    await form.getByLabel('New password').fill('a-brand-new-password')
    await form.getByLabel('Type it again').fill('a-brand-new-password')
    await form.getByRole('button', { name: 'Change password' }).click()
    await expect(form.getByRole('alert')).toContainText("isn't your current password")

    await form.getByLabel('Current password').fill(user.password)
    await form.getByRole('button', { name: 'Change password' }).click()
    await expect(form.getByRole('status')).toContainText('Password changed')
  })

  test('the reset page sends a normal session to Settings', async ({ page }) => {
    await signIn(page, user)
    await expect(page).toHaveURL(/\/app\/domains$/)
    await page.goto('/reset-password')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Change your password in Settings',
    )
  })

  test('two-factor changes wait out the 24 hours after a reset (FR-A6)', async ({ page }) => {
    await setPasswordResetAt(user.id, new Date().toISOString())
    await signIn(page, user, '/sign-in?next=%2Fapp%2Fsettings')

    await expect(page.getByText('Your password was reset.')).toBeVisible()
    await page.getByRole('button', { name: 'Turn on two-factor' }).click()
    await expect(page.locator('#two-factor').getByRole('alert')).toContainText(
      'paused for 24 hours',
    )
  })
})

test.describe('two-factor authentication', () => {
  let user: TestUser

  test.beforeEach(async () => {
    // One project: the flow signs in twice and waits on 30-second codes.
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('twofactor')
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('turning it on means the next sign-in needs a code (FR-A2)', async ({ page }) => {
    test.setTimeout(90_000)
    await signIn(page, user, '/sign-in?next=%2Fapp%2Fsettings')
    await expect(page).toHaveURL(/\/app\/settings$/)

    const panel = page.locator('#two-factor')
    await panel.getByRole('button', { name: 'Turn on two-factor' }).click()
    await expect(panel.getByRole('img', { name: /QR code/ })).toBeVisible()
    const secret = (await panel.locator('code').textContent()) ?? ''

    const setup = panel.getByRole('form', { name: 'Confirm two-factor' })
    await setup.getByLabel('6-digit code').fill(await freshTotpCode(secret))
    await setup.getByRole('button', { name: 'Confirm and turn on' }).click()
    await expect(panel).toContainText('On.')

    await signOutFromPanel(page)
    await expect(page).toHaveURL(/\/$/)

    await signIn(page, user)
    await expect(page).toHaveURL(/\/verify\?next=%2Fapp%2Fdomains$/)

    // The panel stays shut until the code is in.
    await page.goto('/app/domains')
    await expect(page).toHaveURL(/\/verify/)

    const verify = page.getByRole('form', { name: 'Two-factor code' })
    await verify.getByLabel('6-digit code').fill('000000')
    await verify.getByRole('button', { name: 'Continue' }).click()
    await expect(verify.getByRole('alert')).toContainText("didn't work")

    await verify.getByLabel('6-digit code').fill(await freshTotpCode(secret))
    await verify.getByRole('button', { name: 'Continue' }).click()
    await expect(page).toHaveURL(/\/app\/domains$/)
  })
})
