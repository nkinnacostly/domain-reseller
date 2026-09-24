import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { createSandboxDomain, createTestUser, deleteTestUser } from './support/accounts.mjs'
import {
  axe,
  fillRegistrant,
  overflows,
  signInWithDomainInCart,
  type TestUser,
  uniqueName,
} from './support/checkout-flow'

/**
 * Mandatory two-factor above ten domains (PRD FR-A2, SEC-1), end to end. The
 * account holds eleven sandbox domains — real rows on the test side, not demo
 * rows, which never count — and no authenticator: every panel page says so,
 * and checkout refuses before anything is created or charged.
 */

test.describe('an account holding more than ten domains, without two-factor', () => {
  let user: TestUser | undefined

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== 'chromium-desktop', 'sign-in rate limits')
    user = await createTestUser('twofactor', { fullName: 'Ada Okafor' })
    for (let index = 0; index < 11; index += 1) await createSandboxDomain(user.id)
  })
  test.afterEach(async () => {
    if (user) await deleteTestUser(user.id)
  })

  test('is told on every panel page, and cannot order more until it is on', async ({ page }) => {
    await signInWithDomainInCart(page, user as TestUser, uniqueName())

    const notice = page.getByRole('region', { name: 'Turn on two-factor authentication' })
    await expect(notice).toContainText('Your account holds 11 domains')
    await expect(notice).toContainText('Renewals carry on as normal.')
    await expect(notice.getByRole('link', { name: 'Turn on two-factor' })).toHaveAttribute(
      'href',
      '/app/settings#two-factor',
    )

    const form = await fillRegistrant(page)
    await form.getByRole('checkbox', { name: /checked the spelling/ }).check()
    await form.getByRole('button', { name: /^Pay / }).click()
    const refusal = form.getByRole('alert')
    await expect(refusal).toContainText(
      'Accounts holding more than 10 domains need two-factor authentication before ordering more domains.',
    )
    await expect(refusal).toContainText("You haven't been charged.")
    await expect(refusal.getByRole('link', { name: 'Turn on two-factor' })).toBeVisible()
    await expect(page).toHaveURL(/\/app\/checkout$/)

    expect((await axe(page)).violations).toEqual([])

    // S6/S7: the notice and the full country list still fit a 320px phone.
    await page.setViewportSize({ width: 320, height: 800 })
    expect(await overflows(page)).toBe(false)
    const country = form.getByLabel('Country')
    const box = await country.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320)
    await country.selectOption('JP')
    await expect(country).toHaveValue('JP')

    await page.setViewportSize({ width: 1280, height: 900 })
    await notice.getByRole('link', { name: 'Turn on two-factor' }).click()
    await expect(page).toHaveURL(/\/app\/settings#two-factor$/)
    await expect(page.locator('#two-factor')).toContainText('Off, and required.')
    await expect(notice).toBeVisible()

    // S3: every panel page carries it, and it keeps its contrast in the dark theme.
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'))
    await page.goto('/app/domains')
    await expect(notice).toBeVisible()
    const dark = await new AxeBuilder({ page })
      .include('[aria-labelledby="two-factor-required-title"]')
      .withTags(['wcag2aa'])
      .analyze()
    expect(dark.violations).toEqual([])
  })
})
