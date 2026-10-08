import AxeBuilder from '@axe-core/playwright'
import { expect as baseExpect, type Page, test } from '@playwright/test'
import { createTestUser, deleteTestUser, type TestUser } from './support/accounts'
import { readyAccount } from './support/mail-api'

/**
 * Importing another provider's suppression list (migration 68), against the
 * real Supabase project: an owner uploads a CSV export, picks why, and the
 * addresses appear on the list as this account's — then a removal still
 * works for an imported one, which SES never held. Axe in both themes and no
 * sideways scroll at any width. Sign-in on two projects only (rate limits).
 */

const SIGN_IN_PROJECTS = ['chromium-desktop', 'mobile-ios']
const expect = baseExpect.configure({ timeout: 30_000 })
test.use({ reducedMotion: 'reduce' })
const WIDTHS = [320, 375, 414, 768, 1024, 1440, 1920]

async function checkPage(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
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

test.describe('importing a suppression list', () => {
  test.describe.configure({ timeout: 90_000 })
  let owner: TestUser

  test.beforeAll(async () => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    owner = await createTestUser('import', 'Ada Owner')
    await readyAccount(owner, `Import e2e ${Date.now().toString(36)}`)
  })

  test.afterAll(async () => {
    if (owner) await deleteTestUser(owner)
  })

  test('an owner imports a CSV export; the addresses are listed as the account’s', async ({
    page,
  }) => {
    test.skip(!SIGN_IN_PROJECTS.includes(test.info().project.name), 'sign-in rate limits')
    await page.goto(`/sign-in?next=${encodeURIComponent('/dashboard/suppressions')}`)
    const form = page.getByRole('form', { name: 'Sign in', exact: true })
    await form.getByLabel('Email').fill(owner.email)
    await form.getByLabel('Password', { exact: true }).fill(owner.password)
    await form.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).toHaveURL(/\/dashboard\/suppressions$/)

    const card = page.getByRole('region', { name: 'Import a list' })
    await expect(card).toBeVisible()
    await expect(
      page.getByText('Moving from another provider? Import its list above.'),
    ).toBeVisible()
    await checkPage(page)

    await card.getByLabel('The list').setInputFiles({
      name: 'unsubscribes.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'email,created\nada.import@example.com,1\n"BOLA.import@example.com",2\nnobody,3\n',
      ),
    })
    await expect(card.getByRole('status')).toContainText('Found 2 addresses in unsubscribes.csv')
    await card.getByRole('radio', { name: /They unsubscribed/ }).check()
    await checkPage(page)
    await card.getByRole('button', { name: 'Add 2 addresses to the list' }).click()
    await expect(card.getByText('Added 2 addresses to the list.')).toBeVisible()

    for (const address of ['ada.import@example.com', 'bola.import@example.com']) {
      const row = page.locator(`[data-suppression="${address}"]`)
      await expect(row).toContainText('Added to the list')
      await expect(row).toContainText('This account')
    }
    await checkPage(page)

    // An imported address was never on SES's list; removing it still works.
    const row = page.locator('[data-suppression="ada.import@example.com"]')
    await row.getByRole('button', { name: /^Remove/ }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Remove this address from the list?' })
    await dialog.getByRole('button', { name: 'Remove from the list' }).click()
    await expect(dialog).toBeHidden()
    await expect(row).toHaveCount(0)
    await expect(page.locator('[data-suppression="bola.import@example.com"]')).toHaveCount(1)
  })
})
