import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.describe('home page', () => {
  test('renders the search hero', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/find your domain/i)
  })

  test('exposes a skip link as the first focusable element', async ({ page }) => {
    await page.goto('/')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: /skip to content/i })).toBeFocused()
  })

  test('has no detectable accessibility violations', async ({ page }) => {
    await page.goto('/')
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})

test.describe('responsive layout', () => {
  test('never scrolls horizontally at any supported width', async ({ page }) => {
    await page.goto('/')

    for (const width of [320, 375, 414, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(100)

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      expect(overflows, `horizontal overflow at ${width}px`).toBe(false)
    }
  })

  test('keeps a readable side gutter on the narrowest supported screen', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 })
    await page.goto('/')

    const heading = page.getByRole('heading', { level: 1 })
    const box = await heading.boundingBox()
    expect(box).not.toBeNull()
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(12)
  })
})

test.describe('theming', () => {
  test('renders in dark mode without losing contrast', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')

    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(background).not.toBe('rgba(0, 0, 0, 0)')

    const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze()
    expect(results.violations.filter((v) => v.id === 'color-contrast')).toEqual([])
  })
})

test.describe('health', () => {
  test('health endpoint responds', async ({ request }) => {
    const response = await request.get('/api/health')
    expect(response.ok()).toBe(true)
    expect(await response.json()).toMatchObject({ status: 'healthy' })
  })
})
