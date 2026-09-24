import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * Service status. It reads the shared database's `public_status()` live, so
 * the state itself varies from run to run: these tests hold the shape and the
 * honesty of the page, whatever the state is.
 */

const services = (page: Page) => page.getByRole('list', { name: 'Services' })

test.describe('status page', () => {
  test('shows each service, its state, and when it was checked', async ({ page }) => {
    await page.goto('/status')

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Is everything working?')
    for (const title of [
      'Registrations, renewals and nameserver changes',
      'Paid orders',
      'Registry checks',
    ]) {
      // By heading: another line's words can mention "paid orders" too.
      const line = services(page)
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      await expect(line, title).toContainText(/Operational|Delayed/)
    }
    await expect(
      page.getByText(/^Checked at \d{2}:\d{2} on \d{1,2} [A-Z][a-z]+ \d{4}, Lagos time\.$/),
    ).toBeVisible()
  })

  test('the overall state agrees with every line', async ({ page }) => {
    await page.goto('/status')
    await expect(services(page).getByRole('listitem')).toHaveCount(3)

    const delayed = await services(page).locator('[data-state="delayed"]').count()
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText(
      delayed > 0 ? 'Some things are delayed' : 'Everything is running normally',
    )
  })

  test('says what it cannot see', async ({ page }) => {
    await page.goto('/status')
    await expect(page.getByRole('heading', { name: "What this page can't see" })).toBeVisible()
    await expect(page.locator('main')).toContainText(
      'does not test searching, signing in or paying',
    )
  })

  test('has no accessibility violations', async ({ page }) => {
    await page.goto('/status')
    await expect(services(page)).toBeVisible()
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('never scrolls horizontally', async ({ page }) => {
    await page.goto('/status')
    await expect(services(page)).toBeVisible()
    for (const width of [320, 375, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(100)
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      expect(overflows, `horizontal overflow at ${width}px`).toBe(false)
    }
  })

  test('shares the page gutter', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.goto('/status')
    await expect(services(page)).toBeVisible()

    const x = async (locator: ReturnType<Page['locator']>) =>
      Math.round((await locator.boundingBox())?.x ?? -1)
    const logo = await x(page.getByRole('banner').getByRole('link').first())
    expect(await x(page.getByRole('heading', { level: 1 }))).toBe(logo)
    expect(await x(services(page))).toBe(logo)
  })
})
