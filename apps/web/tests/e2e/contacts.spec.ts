import { expect, type Locator, type Page, test } from '@playwright/test'
import {
  contactsForOrder,
  createSandboxDomain,
  createTestUser,
  deleteTestUser,
  enableTotp,
  freshTotpCode,
  settleDomainChange,
  settleRegistration,
  updateTestDomain,
} from './support/accounts.mjs'
import {
  axe,
  fillRegistrant,
  overflows,
  payOnMockFlutterwave,
  signInWithDomainInCart,
  type TestUser,
  uniqueName,
} from './support/checkout-flow'

/**
 * Contact profiles and a domain's four contacts (FR-A4, FR-C5, FR-DS1),
 * against the mock gateway and mock Flutterwave (N12). The gateway's
 * registration and contact jobs are played by settleRegistration() and
 * settleDomainChange() through the same database functions (migration 29).
 */

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

/** Fills a contact's fields inside `scope` — a form or one role's group. */
async function fillContact(
  scope: Locator,
  contact: { first: string; last: string; email: string; phone: string; street: string },
) {
  await scope.getByLabel('First name').fill(contact.first)
  await scope.getByLabel('Last name').fill(contact.last)
  await scope.getByLabel('Email').fill(contact.email)
  await scope.getByLabel('Phone', { exact: true }).fill(contact.phone)
  await scope.getByLabel('Street address').fill(contact.street)
  await scope.getByLabel('City').fill('Lagos')
  await scope.getByLabel('State').fill('Lagos')
  await scope.getByLabel('Postcode').fill('100001')
}

/** The next server action's answer: wait on it, not on `networkidle` (§15). */
const saved = (page: Page) =>
  page.waitForResponse((response) => response.request().method() === 'POST')

async function noOverflow(page: Page) {
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await overflows(page), `horizontal overflow at ${width}px`).toBe(false)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
}

test.describe('contact profiles and the four contacts', () => {
  let user: TestUser | undefined

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
    user = undefined
  })

  test('saved contacts are added, named, made default, edited and deleted (FR-A4)', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    user = await createTestUser('contacts', { fullName: 'Ada Okafor' })
    await signIn(page, user, '/app/settings')
    await expect(page).toHaveURL(/\/app\/settings$/)
    await page.getByRole('link', { name: 'Manage contacts' }).click()
    await expect(page).toHaveURL(/\/app\/settings\/contacts$/)
    await expect(page.getByRole('heading', { name: 'No saved contacts yet' })).toBeVisible()
    expect((await axe(page)).violations).toEqual([])

    // The first contact becomes the default; NG comes with its dialling code.
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Add a contact' }).click()
    let form = page.getByRole('form', { name: 'New contact' })
    await expect(form.getByLabel('Code', { exact: true })).toHaveValue('234')
    await form.getByRole('button', { name: 'Save contact' }).click()
    await expect(form.getByLabel('Name for this contact')).toHaveAttribute('aria-invalid', 'true')

    await form.getByLabel('Name for this contact').fill('Accounts')
    await fillContact(form, {
      first: 'Bola',
      last: 'Ade',
      email: 'accounts@example.com',
      phone: '0803 987 6543',
      street: '2 Broad Street',
    })
    let saving = saved(page)
    await form.getByRole('button', { name: 'Save contact' }).click()
    await saving
    await expect(page.getByRole('main').getByRole('status')).toContainText('Saved “Accounts”.')
    const list = page.getByRole('list', { name: 'Saved contacts' })
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await expect(list).toContainText('Default')
    // E.164: stored as the national number beside its code (FR-A4).
    await expect(list).toContainText('+234 8039876543')

    await page.getByRole('button', { name: 'Add a contact' }).click()
    form = page.getByRole('form', { name: 'New contact' })
    await expect(form.getByRole('checkbox', { name: /Use as my default/ })).not.toBeChecked()
    await form.getByLabel('Name for this contact').fill('Tech desk')
    await fillContact(form, {
      first: 'Chi',
      last: 'Obi',
      email: 'tech@example.com',
      phone: '0803 555 0000',
      street: '3 Awolowo Road',
    })
    saving = saved(page)
    await form.getByRole('button', { name: 'Save contact' }).click()
    await saving
    await expect(list.getByRole('listitem')).toHaveCount(2)

    saving = saved(page)
    await page.getByRole('button', { name: 'Make Tech desk the default' }).click()
    await saving
    await expect(page.getByRole('main').getByRole('status')).toContainText(
      '“Tech desk” is now your default contact.',
    )
    await expect(list.getByRole('listitem').first()).toContainText('Tech desk')
    await expect(list.getByRole('listitem').first()).toContainText('Default')

    await page.getByRole('button', { name: 'Edit Accounts' }).click()
    form = page.getByRole('form', { name: 'Edit Accounts' })
    await form.getByLabel('Street address').fill('9 Broad Street')
    saving = saved(page)
    await form.getByRole('button', { name: 'Save contact' }).click()
    await saving
    await expect(list).toContainText('9 Broad Street')
    expect((await axe(page)).violations).toEqual([])
    await noOverflow(page)

    await page.getByRole('button', { name: 'Delete Accounts' }).click()
    const confirm = page.getByRole('group', { name: 'Delete “Accounts”?' })
    saving = saved(page)
    await confirm.getByRole('button', { name: 'Delete contact' }).click()
    await saving
    await expect(page.getByRole('main').getByRole('status')).toContainText('Deleted “Accounts”.')
    await expect(list.getByRole('listitem')).toHaveCount(1)
  })

  test('checkout with a separate billing contact carries it to the domain (FR-C5)', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    user = await createTestUser('contacts-checkout', { fullName: 'Ada Okafor' })
    const name = uniqueName()
    await signInWithDomainInCart(page, user, name)
    const form = await fillRegistrant(page)

    await form.getByText('Different contacts for administrative, technical or billing?').click()
    const billing = form.getByRole('group', { name: 'Billing contact' })
    await expect(billing.getByRole('radio', { name: 'Same as the registrant' })).toBeChecked()
    await billing.getByRole('radio', { name: 'New details' }).check()
    await fillContact(billing, {
      first: 'Bola',
      last: 'Ade',
      email: 'accounts@example.com',
      phone: '0803 987 6543',
      street: '2 Broad Street',
    })
    await expect(
      form
        .getByRole('group', { name: 'Technical contact' })
        .getByRole('radio', { name: 'Same as the registrant' }),
    ).toBeChecked()
    expect((await axe(page)).violations).toEqual([])
    await noOverflow(page)

    const orderId = await payOnMockFlutterwave(page, 'Pay (test)')

    // Only the role someone else holds is stored, normalised (migration 29).
    const paid = await contactsForOrder(orderId)
    expect(paid.order).toEqual({
      billing: expect.objectContaining({
        firstName: 'Bola',
        lastName: 'Ade',
        email: 'accounts@example.com',
        phoneCountryCode: '234',
        phone: '8039876543',
      }),
    })
    expect(paid.domains).toEqual([paid.order])

    await settleRegistration(orderId, 'registered')
    expect((await contactsForOrder(orderId)).domains).toEqual([paid.order])

    await page.goto(`/app/domains/${name}.com/contacts`)
    const roles = page.getByRole('region', { name: 'Administrative, technical and billing' })
    await expect(roles.getByRole('definition').nth(2)).toContainText('Bola Ade')
    await expect(roles.getByRole('definition').first()).toContainText('Same as the registrant')
    await expect(page.getByRole('region', { name: 'Registrant — the legal owner' })).toContainText(
      'Also the administrative and technical contact.',
    )
  })

  test('a role changed on the Contacts tab waits for the registry, then shows (FR-DS1)', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    user = await createTestUser('contacts-tab', { fullName: 'Ada Okafor' })
    const domain = await createSandboxDomain(user.id)
    await updateTestDomain(domain.id, { registrant: ADA })
    const secret = await enableTotp(user)
    const contacts = `/app/domains/${domain.name}/contacts`
    await signIn(page, user, contacts)
    await expect(page).toHaveURL(/\/verify/)
    const verify = page.getByRole('form', { name: 'Two-factor code' })
    await verify.getByLabel('6-digit code').fill(await freshTotpCode(secret))
    await verify.getByRole('button', { name: 'Continue' }).click()
    await expect(page).toHaveURL(new RegExp(`${contacts.replaceAll('.', '\\.')}$`))

    const roles = page.getByRole('region', { name: 'Administrative, technical and billing' })
    await expect(roles.getByText('Same as the registrant')).toHaveCount(3)
    await page.waitForLoadState('networkidle')

    const technical = page.getByRole('form', { name: 'Change the technical contact' })
    await technical.getByRole('radio', { name: 'New details' }).check()
    await fillContact(technical, {
      first: 'Chi',
      last: 'Obi',
      email: 'tech@example.com',
      phone: '0803 555 0000',
      street: '3 Awolowo Road',
    })
    const saving = saved(page)
    await technical.getByRole('button', { name: 'Save technical contact' }).click()
    await saving
    await expect(technical.getByRole('status')).toContainText('Saved and sent to the registry.')
    // FR-DS2: the 60-day warning is the registrant's alone.
    await expect(technical).not.toContainText('60 days')

    await page.reload()
    await expect(roles.getByRole('definition').nth(1)).toContainText('Waiting for the registry')
    await expect(roles.getByRole('definition').nth(1)).toContainText('Chi Obi')
    expect((await axe(page)).violations).toEqual([])
    await noOverflow(page)

    await settleDomainChange(domain.id, 'update_contacts')
    await page.reload()
    await expect(roles).not.toContainText('Waiting for the registry')
    await expect(roles.getByRole('definition').nth(1)).toContainText('Chi Obi')
    await expect(roles.getByText('Same as the registrant')).toHaveCount(2)

    // Back to the registrant: an empty set of roles once the registry confirms.
    await page.waitForLoadState('networkidle')
    const back = page.getByRole('form', { name: 'Change the technical contact' })
    await back.getByRole('radio', { name: 'Same as the registrant' }).check()
    const handing = saved(page)
    await back.getByRole('button', { name: 'Save technical contact' }).click()
    await handing
    await page.reload()
    await expect(roles).toContainText('Going back to the registrant once the registry confirms it.')
    await settleDomainChange(domain.id, 'update_contacts')
    await page.reload()
    await expect(roles.getByText('Same as the registrant')).toHaveCount(3)

    await page
      .getByRole('navigation', { name: 'Domain' })
      .getByRole('link', { name: 'Activity' })
      .click()
    const log = page.getByRole('list', { name: 'Activity' })
    await expect(log).toContainText('Asked to change the technical contact')
    await expect(log).toContainText('Contacts updated at the registry')
    // N13: the activity log never carries contact details.
    await expect(log).not.toContainText('tech@example.com')
  })
})
