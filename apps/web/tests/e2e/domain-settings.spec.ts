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
  updateTestDomain,
} from './support/accounts.mjs'

/**
 * Registry-side settings (PRD E10: FR-DS1 – FR-DS5, SEC-2) on a sandbox
 * domain. The web app records each request and queues it; the gateway's
 * answer is played by settleDomainChange() through the same database
 * functions (migration 26), and the transfer code comes from the mock
 * gateway — nothing here reaches a registry (N12).
 */

type TestUser = { id: string; email: string; password: string }

const ADA = {
  firstName: 'Ada',
  lastName: 'Okafor',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '1 Marina',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}

async function signIn(page: Page, user: TestUser, next: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
}

/** Signs in and enters the second factor, so sensitive changes are allowed (SEC-2). */
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

async function noOverflowAt320(page: Page) {
  await page.setViewportSize({ width: 320, height: 900 })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
}

/** The next server action's answer: wait on it, not on `networkidle` (§15). */
const saved = (page: Page) =>
  page.waitForResponse((response) => response.request().method() === 'POST')

const activity = async (page: Page) => {
  await page
    .getByRole('navigation', { name: 'Domain' })
    .getByRole('link', { name: 'Activity' })
    .click()
  return page.getByRole('list', { name: 'Activity' })
}

test.describe('registry-side settings on a sandbox domain', () => {
  let user: TestUser | undefined
  let secret: string
  let domain: { id: string; name: string }

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('settings', { fullName: 'Ada Okafor' })
    domain = await createSandboxDomain(user.id)
    await updateTestDomain(domain.id, {
      transfer_lock: true,
      privacy_enabled: false,
      registrant: ADA,
    })
    secret = await enableTotp(user)
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('lock off after a warning, privacy refused, and the transfer code shown once (FR-DS3 – FR-DS5)', async ({
    page,
  }) => {
    test.setTimeout(150_000)
    const security = `/app/domains/${domain.name}/security`
    await signInWithCode(page, user as TestUser, secret, security)
    await expect(page.getByText('Sandbox domain.', { exact: true })).toBeVisible()
    expect((await axe(page)).violations).toEqual([])

    // FR-DS4: off only after the warning; waiting until the registry confirms.
    const lock = page.getByRole('switch', { name: 'Transfer lock' })
    await expect(lock).toBeChecked()
    await page.waitForLoadState('networkidle')
    await lock.click()
    await expect(page.getByRole('group', { name: 'Turn off the transfer lock?' })).toBeVisible()
    const unlocking = saved(page)
    await page.getByRole('button', { name: 'Turn off transfer lock' }).click()
    await unlocking
    await expect(lock).toHaveAccessibleDescription('Turning off — waiting for the registry')
    await expect(lock).not.toBeChecked()

    await settleDomainChange(domain.id, 'set_transfer_lock')
    await page.reload()
    await expect(page.getByRole('switch', { name: 'Transfer lock' })).toHaveAccessibleDescription(
      /^Off — /,
    )

    // FR-DS3: a refusal is shown as one, and the domain keeps what it had.
    const privacy = page.getByRole('switch', { name: 'Contact privacy' })
    await page.waitForLoadState('networkidle')
    const asking = saved(page)
    await privacy.click()
    await asking
    await expect(privacy).toHaveAccessibleDescription('Turning on — waiting for the registry')
    await settleDomainChange(domain.id, 'set_privacy', 'REGISTRY_REFUSED')
    await page.reload()
    await expect(page.getByRole('switch', { name: 'Contact privacy' })).not.toBeChecked()

    // FR-DS5: the code straight from the registry's side, shown once.
    const reveal = saved(page)
    await page.getByRole('button', { name: 'Get transfer code' }).click()
    await reveal
    await expect(page.getByText('E2E-OTE-7qX!code')).toBeVisible()
    await expect(page.getByRole('main')).toContainText('moves no real domain')
    expect((await axe(page)).violations).toEqual([])
    await noOverflowAt320(page)
    await page.setViewportSize({ width: 1280, height: 900 })

    const log = await activity(page)
    await expect(log).toContainText('Transfer lock turned off at the registry')
    await expect(log).toContainText('Asked to turn the transfer lock off')
    await expect(log).toContainText(
      'Contact privacy change refused by the registry: The registry could not complete it.',
    )
    await expect(log).toContainText('Transfer code shown, from the registrar’s test system')
    await expect(page.getByRole('main')).not.toContainText('E2E-OTE-7qX!code')
  })

  test('a new registrant needs the 60-day lock accepted, then waits for the registry (FR-DS1, FR-DS2)', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const contacts = `/app/domains/${domain.name}/contacts`
    await signInWithCode(page, user as TestUser, secret, contacts)
    const form = page.getByRole('form', { name: 'Change the registrant' })
    await expect(form.getByLabel('Last name')).toHaveValue('Okafor')
    await page.waitForLoadState('networkidle')

    await form.getByLabel('Last name').fill('Obi')
    const accept = form.getByRole('checkbox', {
      name: 'I understand this domain may not move to another registrar for 60 days.',
    })
    await expect(accept).toBeVisible()
    const refused = saved(page)
    await form.getByRole('button', { name: 'Save registrant' }).click()
    await refused
    await expect(form.getByRole('alert')).toContainText('Tick the box to go ahead.')

    await accept.check()
    const saving = saved(page)
    await form.getByRole('button', { name: 'Save registrant' }).click()
    await saving
    await expect(form.getByRole('status')).toContainText('Saved and sent to the registry.')

    await page.reload()
    const registrant = page.getByRole('region', { name: 'Registrant — the legal owner' })
    await expect(registrant).toContainText('Waiting for the registry')
    await expect(registrant).toContainText('Ada Obi')
    expect((await axe(page)).violations).toEqual([])
    await noOverflowAt320(page)
    await page.setViewportSize({ width: 1280, height: 900 })

    await settleDomainChange(domain.id, 'update_contacts')
    await page.reload()
    await expect(registrant).not.toContainText('Waiting for the registry')
    await expect(registrant).toContainText('Ada Obi')

    const log = await activity(page)
    await expect(log).toContainText('Asked to change the registrant')
    // One job applies all four contacts (migration 29).
    await expect(log).toContainText('Contacts updated at the registry')
    // N13: the activity log never carries contact details.
    await expect(log).not.toContainText('ada@example.com')
  })
})

test.describe('a demo domain’s settings', () => {
  let user: TestUser | undefined
  let name: string

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('settings-demo', { fullName: 'Ada Okafor' })
    name = (await createDemoDomain(user.id)).name
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('are switched off and say why: nothing reaches a registry', async ({ page }) => {
    await signIn(page, user as TestUser, `/app/domains/${name}/security`)
    await expect(page.getByText('Demo domain.', { exact: true })).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Transfer lock' })).toBeDisabled()
    await expect(page.getByRole('switch', { name: 'Contact privacy' })).toBeDisabled()
    await expect(page.getByText('No transfer code.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Get transfer code' })).toHaveCount(0)
    expect((await axe(page)).violations).toEqual([])
    await noOverflowAt320(page)

    await page.setViewportSize({ width: 1280, height: 900 })
    await page
      .getByRole('navigation', { name: 'Domain' })
      .getByRole('link', { name: 'Contacts' })
      .click()
    await expect(page.getByRole('form', { name: 'Change the registrant' })).toHaveCount(0)
    await expect(page.getByRole('form', { name: 'Change the billing contact' })).toHaveCount(0)
    await expect(page.getByText('Demo domain.', { exact: true })).toBeVisible()
    expect((await axe(page)).violations).toEqual([])
  })
})
