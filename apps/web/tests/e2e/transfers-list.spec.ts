import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { createSandboxDomain, createTestUser, deleteTestUser } from './support/accounts.mjs'

/** The list of transfers in (PRD E9), from rows as settled transfers leave them. */

type TestUser = { id: string; email: string; password: string }

async function signIn(page: Page, user: TestUser, next: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(user.email)
  await form.getByLabel('Password', { exact: true }).fill(user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${next}$`))
}

test.describe('transfers list', () => {
  let user: TestUser | undefined

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('transfers', { fullName: 'Ada Okafor' })
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('says there are none yet, and where to start', async ({ page }) => {
    await signIn(page, user as TestUser, '/app/transfers')
    const main = page.getByRole('main')
    await expect(main.getByText('You haven’t transferred a domain here yet.')).toBeVisible()
    await expect(main.getByRole('link', { name: 'Check a domain you own' })).toHaveAttribute(
      'href',
      '/transfer',
    )
    // S13 — the sidebar marks where you are.
    await expect(
      page.getByRole('navigation').getByRole('link', { name: 'Transfers' }).first(),
    ).toHaveAttribute('aria-current', 'page')
  })

  test('lists transfers still moving above finished ones', async ({ page }) => {
    const owner = user as TestUser
    const moving = await createSandboxDomain(owner.id, {
      source: 'transfer',
      status: 'transfer_pending',
    })
    const arrived = await createSandboxDomain(owner.id, { source: 'transfer', status: 'active' })
    const refused = await createSandboxDomain(owner.id, {
      source: 'transfer',
      status: 'transfer_rejected',
    })
    // A registration is not a transfer, and is not listed.
    const registered = await createSandboxDomain(owner.id)

    await signIn(page, owner, '/app/transfers')
    const open = page.getByRole('list', { name: 'In progress' })
    const finished = page.getByRole('list', { name: 'Finished' })
    await expect(open.locator(`[data-transfer="${moving.name}"]`)).toContainText('5 days')
    await expect(finished.locator(`[data-transfer="${arrived.name}"]`)).toContainText(
      'Transferred in the registrar’s test system.',
    )
    await expect(finished.locator(`[data-transfer="${refused.name}"]`)).toContainText(
      'no money moved',
    )
    await expect(page.locator(`[data-transfer="${registered.name}"]`)).toHaveCount(0)

    await expect(finished.getByRole('link', { name: arrived.name })).toHaveAttribute(
      'href',
      `/app/domains/${arrived.name}`,
    )
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    }
  })
})
