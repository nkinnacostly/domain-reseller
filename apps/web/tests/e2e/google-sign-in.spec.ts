import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { authProviders } from './support/accounts.mjs'

/**
 * "Continue with Google" (FR-A1). The button follows what the hosted
 * Supabase Auth has switched on, so this checks whichever state it is in.
 * Google's own pages are not driven here — only that we hand over to them.
 */

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

const overflows = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )

test.describe('Google sign-in', () => {
  test('is offered on sign-in and sign-up exactly when it is switched on', async ({ page }) => {
    const { google } = await authProviders()
    for (const path of ['/sign-in', '/sign-up']) {
      await page.goto(path)
      const button = page.getByRole('button', { name: 'Continue with Google' })
      if (!google) {
        await expect(button).toHaveCount(0)
        continue
      }
      await expect(button).toBeVisible()
      await expect(page.getByText('or with your email')).toBeVisible()
      expect((await axe(page)).violations).toEqual([])
      await page.setViewportSize({ width: 320, height: 800 })
      expect(await overflows(page), `overflow at 320px on ${path}`).toBe(false)
      await page.setViewportSize({ width: 1280, height: 800 })
    }
  })

  test('hands over to Google, and explains a sign-in Google sent back', async ({ page }) => {
    const { google } = await authProviders()
    test.skip(!google, 'Google sign-in is not switched on in Supabase yet')

    await page.goto('/sign-in?error=oauth')
    await expect(page.getByText(/Google sign-in did not finish/)).toBeVisible()

    await page.goto('/sign-in?next=%2Fapp%2Fdomains')
    await page.getByRole('button', { name: 'Continue with Google' }).click()
    await expect(page).toHaveURL(/accounts\.google\.com/, { timeout: 20_000 })
  })
})
