import AxeBuilder from '@axe-core/playwright'
import { expect as baseExpect, type Page, test } from '@playwright/test'
import {
  createTestUser,
  deleteTestUser,
  mailAccountIdsOf,
  setTestPlan,
  type TestUser,
} from './support/accounts'

/**
 * MAIL-SPEC §7.1, §7.2, §9, §10 against the real Supabase project: sign up,
 * sign in, onboarding into the sandbox, the dashboard and its pages, an
 * invite accepted by another person, and Settings — with axe and no sideways
 * scroll at every width, in both themes.
 *
 * People are created confirmed through the admin API, so nothing here sends
 * an email (the sign-up form is tried with an address that already has a
 * sign-in: Supabase answers as for a new one and sends nothing). Journeys
 * that sign in run on two projects only: Supabase limits sign-ins per address.
 */

const SIGN_IN_PROJECTS = ['chromium-desktop', 'mobile-ios']

// Every step here waits on the hosted project, whose answers can take seconds.
const expect = baseExpect.configure({ timeout: 30_000 })

// axe measures colours as drawn: with motion reduced (S9 honours it) no button
// is caught half-way through a fade, and no dialog half-way in.
test.use({ reducedMotion: 'reduce' })
const WIDTHS = [320, 375, 414, 768, 1024, 1440, 1920]

async function fitsEveryWidth(page: Page) {
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

/** axe on the page, or on one part of it — an open dialog, whose backdrop dims the rest. */
async function passesAxe(page: Page, only?: string) {
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

/** Both themes (S3), every width (S5), and axe in each. */
async function checkPage(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await passesAxe(page)
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await fitsEveryWidth(page)
}

async function signIn(page: Page, user: TestUser, path = '/sign-in') {
  await page.goto(path)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
}

/** The dashboard's pages are in the sidebar from `lg`, in a drawer below it. */
async function openPage(page: Page, name: string) {
  const menu = page.getByRole('button', { name: /^Menu/ })
  if (await menu.isVisible()) {
    await expect(async () => {
      await menu.click({ timeout: 1_000 })
      await expect(page.getByRole('dialog', { name: 'Dashboard menu' })).toBeVisible({
        timeout: 1_000,
      })
    }).toPass({ timeout: 15_000 })
    await page
      .getByRole('dialog', { name: 'Dashboard menu' })
      .getByRole('link', { name, exact: true })
      .click()
  } else {
    await page
      .getByRole('navigation', { name: 'Dashboard' })
      .getByRole('link', { name, exact: true })
      .click()
  }
}

test.describe('signed out', () => {
  for (const path of ['/sign-in', '/sign-up', '/forgot-password']) {
    test(`${path} passes axe in both themes and fits every width`, async ({ page }) => {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await checkPage(page)
    })
  }

  test('the signed-in pages send a visitor to sign in, and remember where to', async ({ page }) => {
    for (const path of ['/dashboard/settings', '/onboarding']) {
      await page.goto(path)
      await expect(page).toHaveURL(new RegExp(`/sign-in\\?next=${encodeURIComponent(path)}$`))
    }
  })

  test('sign-up checks the form before anything is sent', async ({ page }) => {
    await page.goto('/sign-up')
    const form = page.getByRole('form', { name: 'Create an account' })
    await form.getByLabel('Your name').fill('Ada Okafor')
    await form.getByLabel('Email').fill('not-an-email')
    await form.getByLabel('Password', { exact: true }).fill('short')
    await form.getByRole('button', { name: 'Create account' }).click()
    await expect(form.getByText('Enter a valid email address')).toBeVisible()
    await expect(form.getByText('Use at least 10 characters')).toBeVisible()
    await expect(form.getByLabel('Your name')).toHaveValue('Ada Okafor')
  })

  test('a dead email link explains itself', async ({ page }) => {
    await page.goto('/auth/confirm?token_hash=nope&type=email')
    await expect(page).toHaveURL(/\/sign-in\?error=expired$/)
    await expect(page.getByText('That link has expired or was already used')).toBeVisible()
  })
})

test.describe('the account journey', () => {
  test.describe.configure({ mode: 'serial' })
  let owner: TestUser
  let invitee: TestUser
  let inviteLink = ''
  const accountName = `Acme e2e ${Date.now()}`

  test.beforeAll(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    owner = await createTestUser('owner', 'Ada Owner')
    invitee = await createTestUser('invitee', 'Bola Invitee')
  })

  test.afterAll(async () => {
    if (owner) await deleteTestUser(owner)
    if (invitee) await deleteTestUser(invitee)
  })

  test.beforeEach(() => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
  })

  test('sign-up answers as it always does, behind the human check (§7.1)', async ({ page }) => {
    const response = await page.goto('/sign-up')
    expect(response?.headers()['content-security-policy']).toContain(
      'frame-src https://challenges.cloudflare.com',
    )
    const form = page.getByRole('form', { name: 'Create an account' })
    await form.getByLabel('Your name').fill('Ada Owner')
    await form.getByLabel('Email').fill(owner.email)
    await form.getByLabel('Password', { exact: true }).fill(owner.password)
    await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue('', {
      timeout: 15_000,
    })
    await form.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByText('Check your email')).toBeVisible()
  })

  test('first sign-in leads to onboarding, into the sandbox (§7.2)', async ({ page }) => {
    await signIn(page, owner, '/sign-in?next=%2Fdashboard')
    await expect(page).toHaveURL(/\/onboarding$/)
    await expect(page.getByRole('heading', { name: 'Set up your Mail account' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'It starts in the sandbox' })).toBeVisible()
    await checkPage(page)

    const form = page.getByRole('form', { name: 'Create a Mail account' })
    await form.getByRole('button', { name: 'Create the account' }).click()
    await expect(form.getByText('Enter a name for the account')).toBeVisible()
    await expect(form.getByText(/Mail is for transactional email only/)).toBeVisible()

    await form.getByLabel('Account name').fill(accountName)
    await form.getByLabel('Website').fill('acme.example')
    await form.getByLabel('What will you send?').fill('Order receipts and password resets.')
    await form.getByLabel('About how many emails a month?').fill('5,000')
    await form.getByLabel('I will send transactional email only').check()
    await form.getByRole('button', { name: 'Create the account' }).click()

    await expect(page).toHaveURL(/\/dashboard\?welcome=1$/)
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
    await expect(page.getByText('Your account is ready')).toBeVisible()
    const banner = page.getByRole('region', { name: 'Account status' })
    await expect(banner).toContainText('This account is in the sandbox')
    await expect(banner).toContainText(/up to \d+ a day/)
    await expect(page.getByRole('meter', { name: 'This month' })).toHaveAttribute('max', '3000')
    await expect(page.getByText('Nothing sent yet this month')).toBeVisible()
    const steps = page.getByRole('region', { name: 'Next steps' })
    await expect(steps.locator('[data-step="domain"]')).toContainText('To do')
    await expect(steps.locator('[data-step="profile"]')).toContainText('Done')
    await expect(steps.locator('[data-step="review"]')).toContainText('Approval by our team')
    await checkPage(page)
  })

  test('every dashboard page is there, and the menu says which one you are on (S13)', async ({
    page,
  }) => {
    await signIn(page, owner, '/sign-in?next=%2Fdashboard')
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
    for (const name of ['Emails', 'Domains', 'API keys', 'Webhooks', 'Suppressions', 'Billing']) {
      await openPage(page, name)
      await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'This page is coming' })).toBeVisible()
      const current = page
        .getByRole('navigation', { name: 'Dashboard' })
        .locator('[aria-current="page"]')
      if (await page.getByRole('button', { name: /^Menu/ }).isHidden()) {
        await expect(current).toHaveText(name)
      }
    }
    await checkPage(page)
    await openPage(page, 'Settings')
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    await expect(
      page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Profile' }),
    ).toHaveAttribute('aria-current', 'page')
  })

  test('settings: the profile, a refused invite on Free, then an invite link (§8, §9)', async ({
    page,
  }) => {
    await signIn(page, owner, '/sign-in?next=%2Fdashboard%2Fsettings')
    const profile = page.getByRole('form', { name: 'Account profile' })
    await expect(profile.getByLabel('Website')).toHaveValue('https://acme.example')
    await profile.getByLabel('Website').fill('https://www.acme.example')
    await profile.getByRole('button', { name: 'Save profile' }).click()
    await expect(profile.getByText('Saved.')).toBeVisible()
    await checkPage(page)

    await page.goto('/dashboard/settings/members')
    await expect(page.getByText('1 of 1 seat on the Free plan taken')).toBeVisible()
    const invite = page.getByRole('form', { name: 'Invite someone' })
    await invite.getByLabel('Their email').fill(invitee.email)
    await invite.getByRole('button', { name: 'Make an invite link' }).click()
    await expect(invite.getByText(/This plan has 1 member seat/)).toBeVisible()

    const [accountId] = await mailAccountIdsOf(owner)
    if (!accountId) throw new Error('the owner has no account')
    await setTestPlan(accountId, 'starter')
    await page.reload()
    await expect(page.getByText('1 of 3 seats on the Starter plan taken')).toBeVisible()
    await invite.getByLabel('Their email').fill(invitee.email)
    await invite.getByLabel('Role', { exact: true }).selectOption('developer')
    await invite.getByRole('button', { name: 'Make an invite link' }).click()
    await expect(page.getByText('We don’t email invites yet')).toBeVisible()
    inviteLink = await page.getByLabel('Invite link').inputValue()
    expect(inviteLink).toMatch(/\/invite\?token=[A-Za-z0-9_-]{43}$/)
    await expect(page.locator(`[data-invite="${invitee.email}"]`)).toContainText('Developer')
    await checkPage(page)

    await page.goto('/dashboard/settings/log')
    const log = page.getByRole('table', { name: 'The account log' })
    await expect(log).toContainText('invited someone as developer')
    await expect(log).toContainText('changed the account’s website')
    await expect(log).toContainText('created the account')
    await checkPage(page)
  })

  test('the invited person joins with the link, as the address it was sent to', async ({
    page,
  }) => {
    expect(inviteLink).not.toBe('')
    const path = new URL(inviteLink).pathname + new URL(inviteLink).search
    await page.goto(path)
    await expect(page).toHaveURL(/\/sign-in\?next=/)
    const form = page.getByRole('form', { name: 'Sign in', exact: true })
    await form.getByLabel('Email').fill(invitee.email)
    await form.getByLabel('Password', { exact: true }).fill(invitee.password)
    await form.getByRole('button', { name: 'Sign in', exact: true }).click()

    await expect(page.getByRole('heading', { name: `Join ${accountName}` })).toBeVisible()
    await checkPage(page)
    await page.getByRole('button', { name: `Join ${accountName}` }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
    await expect(page.getByText(`${accountName} · you are developer`)).toBeVisible()

    // The link works once: opened again, it says the person is already in.
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'You are already a member' })).toBeVisible()

    // Anyone signed in with another address learns only that it is not theirs.
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/$/)
    await signIn(page, owner, `/sign-in?next=${encodeURIComponent(path)}`)
    await expect(page.getByRole('heading', { name: 'This invite can’t be used' })).toBeVisible()
    await expect(page.getByText('sent to a different email address')).toBeVisible()
    await expect(page.getByText(accountName)).toHaveCount(0)
  })

  test('the owner changes the new member’s role, then removes them; security is there', async ({
    page,
  }) => {
    await signIn(page, owner, '/sign-in?next=%2Fdashboard%2Fsettings%2Fmembers')
    const row = page.locator(`[data-member="${invitee.email}"]`)
    await expect(row).toContainText('Bola Invitee')
    await expect(row).toContainText('Developer')
    await row.getByLabel('Role', { exact: true }).selectOption('viewer')
    await row.getByRole('button', { name: 'Change role' }).click()
    await expect(row.getByText('Role changed.')).toBeVisible()
    await expect(row).toContainText('Viewer')
    await checkPage(page)

    await row.getByRole('button', { name: 'Remove' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Remove Bola Invitee?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveCSS('opacity', '1')
    await passesAxe(page, '[role="alertdialog"]')
    await dialog.getByRole('button', { name: 'Remove from the account' }).click()
    await expect(row).toHaveCount(0)

    await page.goto('/dashboard/settings/security')
    await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible()
    await expect(page.getByRole('form', { name: 'Change password' })).toBeVisible()
    await expect(page.getByText(/one password and one authenticator for both/)).toBeVisible()
    await checkPage(page)
  })
})
