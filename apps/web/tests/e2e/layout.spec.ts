import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * Every public page shares the home page's frame: the blue hero panel with
 * the header floating on it, a plain page background (no card on a canvas),
 * and the navy footer. The checks below hold that frame in place.
 */

const PAGES = [
  '/pricing',
  '/search?q=getpaid',
  '/transfer',
  '/cart',
  '/legal',
  '/help',
  '/does-not-exist',
] as const

const background = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.background = 'var(--background)'
    document.body.append(probe)
    const expected = getComputedStyle(probe).backgroundColor
    probe.remove()
    return [getComputedStyle(document.body).backgroundColor, expected]
  })

for (const path of PAGES) {
  test(`${path} opens with the blue hero, on a plain page`, async ({ page }) => {
    await page.goto(path)

    const panel = await page.getByTestId('hero-panel').boundingBox()
    const logo = await page.getByRole('banner').getByRole('link').first().boundingBox()
    const h1 = await page.getByRole('heading', { level: 1 }).boundingBox()
    expect(panel).not.toBeNull()

    // The logo and the page heading both sit on the panel.
    for (const [label, box] of [
      ['logo', logo],
      ['h1', h1],
    ] as const) {
      expect(box, `${label} not found`).not.toBeNull()
      expect(box?.y ?? -1, `${label} above the panel`).toBeGreaterThan(panel?.y ?? 0)
      expect((box?.y ?? 0) + (box?.height ?? 0), `${label} below the panel`).toBeLessThan(
        (panel?.y ?? 0) + (panel?.height ?? 0),
      )
    }

    const [body, expected] = await background(page)
    expect(body, 'the page sits on a coloured canvas').toBe(expected)
    await expect(page.getByRole('contentinfo')).toBeVisible()
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`${path} has no accessibility violations in ${theme} mode`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme', t), theme)
      await page.goto(path)
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/)
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
      expect(results.violations).toEqual([])
    })
  }
}

test('extension links land on that extension’s row on the pricing page', async ({ page }) => {
  await page.goto('/')
  const card = page
    .locator('section', { has: page.getByRole('heading', { name: 'Popular extensions' }) })
    .getByRole('link')
    .first()
  const href = await card.getAttribute('href')
  expect(href).toMatch(/^\/pricing#tld-[a-z.]+$/)

  await card.click()
  await expect(page).toHaveURL(/\/pricing#tld-/)
  await expect(page.locator(`[id="${href?.split('#')[1]}"]`)).toBeInViewport()
})

test('the footer’s extension links point at real pricing rows', async ({ page }) => {
  await page.goto('/pricing')
  const hrefs = await page
    .getByRole('contentinfo')
    .locator('a[href^="/pricing#tld-"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))
  expect(hrefs.length).toBeGreaterThan(0)
  for (const href of hrefs) {
    await expect(page.locator(`[id="${href.split('#')[1]}"]`), href).toBeAttached()
  }
})
