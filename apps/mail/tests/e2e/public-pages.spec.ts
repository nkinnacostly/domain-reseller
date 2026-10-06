import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { leftEdges, noHorizontalOverflow, PUBLIC_PAGES, WIDE } from './support/public-pages'

/**
 * Every public page (MAIL-SPEC §10) shares the frame: the blue panel with
 * the header floating on it (CLAUDE.md §15), the navy footer, both themes
 * clean under axe (S3, S8), no sideways scroll from 320 to 1920 (S5), and
 * one left edge for every section (S4).
 */

for (const path of PUBLIC_PAGES) {
  test.describe(path, () => {
    test('opens with the blue panel, the header floating on it', async ({ page }) => {
      await page.goto(path)
      const panel = await page.getByTestId('hero-panel').first().boundingBox()
      const banner = page.getByRole('banner')
      const logo = await banner
        .getByRole('link', { name: 'MyDomainsHub Mail, home', exact: true })
        .boundingBox()
      const h1 = await page.getByRole('heading', { level: 1 }).boundingBox()
      expect(panel).not.toBeNull()
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
      // The banner is outside <main>; the h1 inside it.
      await expect(page.locator('main header')).toHaveCount(0)
      await expect(page.locator('main h1')).toHaveCount(1)
      await expect(page.getByRole('contentinfo')).toContainText('CLOOP UNIVERSE TECH LTD')
    })

    for (const theme of ['light', 'dark'] as const) {
      test(`passes axe in the ${theme} theme`, async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem('theme', value), theme)
        await page.goto(path)
        await expect(page.locator('html')).toHaveClass(
          theme === 'dark' ? /\bdark\b/ : /^(?!.*dark)/,
        )
        const results = await new AxeBuilder({ page }).analyze()
        expect(results.violations).toEqual([])
      })
    }

    test('never scrolls sideways, 320 to 1920px', async ({ page }) => {
      await page.goto(path)
      await noHorizontalOverflow(page)
    })

    test('every section shares one left edge (S4)', async ({ page }) => {
      for (const width of WIDE) {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(path)
        const { edges, loose } = await leftEdges(page)
        expect(loose, `blocks in <main> without Container at ${width}px`).toEqual([])
        expect(Object.keys(edges).length).toBeGreaterThan(3)
        const unique = [...new Set(Object.values(edges))]
        expect(unique, `left edges differ at ${width}px: ${JSON.stringify(edges)}`).toHaveLength(1)
      }
    })
  })
}

test.describe('the header', () => {
  test('links Pricing, Docs, Sign in and Get started, and marks the current page', async ({
    page,
    isMobile,
  }) => {
    await page.goto('/pricing')
    const banner = page.getByRole('banner')
    if (isMobile) {
      // Below `sm` the header holds only the logo, the theme and the menu.
      await expect(banner.getByRole('link', { name: 'Get started' }).first()).toBeHidden()
      await banner.getByRole('button', { name: 'Open menu' }).click()
      const menu = banner.getByRole('navigation', { name: 'Mobile' })
      await expect(menu.getByRole('link', { name: 'Pricing' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      await expect(menu.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs')
      await expect(menu.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in')
      await expect(menu.getByRole('link', { name: 'Get started' })).toHaveAttribute(
        'href',
        '/sign-up',
      )
      await menu.getByRole('link', { name: 'Docs' }).click()
      await expect(page).toHaveURL(/\/docs$/)
      await expect(banner.getByRole('navigation', { name: 'Mobile' })).toBeHidden()
    } else {
      const main = banner.getByRole('navigation', { name: 'Main' })
      await expect(main.getByRole('link', { name: 'Pricing' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      await expect(main.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs')
      await expect(banner.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
        'href',
        '/sign-in',
      )
      await expect(banner.getByRole('link', { name: 'Get started' })).toHaveAttribute(
        'href',
        '/sign-up',
      )
    }
  })

  test('switches to the dark theme and back', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Use the dark theme' }).click()
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await page.getByRole('button', { name: 'Use the light theme' }).click()
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
  })
})

test.describe('the home page', () => {
  test('shows the real request, and how it works, and what protects you', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Transactional email for Nigerian businesses',
    )
    const code = page.getByRole('region', { name: 'Sending an email with curl' })
    await expect(code).toContainText('curl -X POST https://emails.mydomainshub.com/api/v1/emails')
    await expect(code).toContainText('"subject": "Your receipt"')
    await expect(page.getByRole('heading', { name: 'Verify your domain' })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'What protects your sending reputation' }),
    ).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Not open yet' })).toBeVisible()
  })

  test('the code scrolls inside its own box on a phone, never the page', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto('/')
    const scroll = await page
      .getByRole('region', { name: 'Sending an email with curl' })
      .evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(scroll).toBe(true)
    await noHorizontalOverflow(page)
  })
})
