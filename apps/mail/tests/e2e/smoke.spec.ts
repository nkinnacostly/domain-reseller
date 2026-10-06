import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * The foundation's pages: they render, pass axe, never scroll sideways (S5),
 * work in both themes (S3), and the dashboard is for the signed in. The v1
 * API answers without a key the way the spec says (§6).
 */

const WIDTHS = [320, 375, 414, 768, 1024, 1440, 1920]

async function noHorizontalOverflow(page: Page) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `${width}px`).toBeLessThanOrEqual(0)
  }
}

for (const scheme of ['light', 'dark'] as const) {
  test(`home: renders, passes axe and fits every width (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'MyDomainsHub Mail, home', exact: true }),
    ).toBeVisible()
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations).toEqual([])
    await noHorizontalOverflow(page)
  })
}

test('the dashboard sends a signed-out visitor to sign in', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fdashboard$/)
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
  await noHorizontalOverflow(page)
})

test('the v1 API refuses a request without a key, in the spec’s shape', async ({ request }) => {
  const response = await request.post('/api/v1/emails', { data: {} })
  expect(response.status()).toBe(401)
  expect(response.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  expect(await response.json()).toMatchObject({ name: 'unauthorized' })
})
