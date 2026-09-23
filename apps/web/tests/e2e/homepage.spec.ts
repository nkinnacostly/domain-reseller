import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.describe('homepage structure', () => {
  test('has one h1 and a heading for every section', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)

    // Scoped to main: the footer has its own headings.
    const main = page.locator('main')
    for (const heading of [
      'Popular extensions',
      'Also worth a look',
      'Three steps, no tutorial',
      'Built for how domains are actually bought in Nigeria',
      'How we work out your price',
      'Questions people actually ask',
      'Find the name before someone else does',
    ]) {
      await expect(main.getByRole('heading', { name: heading })).toBeVisible()
    }
  })

  test('the hero is inside main, and the header stays a banner landmark', async ({ page }) => {
    await page.goto('/')

    // The h1 and the primary search belong to main, not to the header.
    await expect(page.locator('main h1')).toBeVisible()
    await expect(page.getByRole('form', { name: 'Domain search', exact: true })).toBeVisible()
    await expect(
      page.getByRole('form', { name: 'Domain search, end of page', exact: true }),
    ).toBeAttached()
    await expect(page.locator('main banner')).toHaveCount(0)
    await expect(page.getByRole('banner')).toBeVisible()
    await expect(page.getByRole('contentinfo')).toBeVisible()
  })

  test('the skip link target exists and sits before the hero heading', async ({ page }) => {
    await page.goto('/')
    const main = page.locator('#main')
    await expect(main).toBeAttached()
    await expect(main.getByRole('heading', { level: 1 })).toBeVisible()
  })
})

test.describe('footer compliance', () => {
  /**
   * These links are ICANN obligations that flow down to us as a reseller
   * (PRD CMP-2, CMP-4, CMP-5). Removing one is a compliance regression,
   * not a design change.
   */
  test('links the registrant rights specification', async ({ page }) => {
    await page.goto('/')
    await expect(
      page
        .getByRole('contentinfo')
        .getByRole('link', { name: /registrants' rights/i })
        .first(),
    ).toBeVisible()
  })

  test('publishes an abuse contact', async ({ page }) => {
    await page.goto('/')
    const footer = page.getByRole('contentinfo')
    await expect(footer.getByRole('link', { name: /report abuse/i })).toBeVisible()
    await expect(footer.locator('a[href^="mailto:"]')).toBeVisible()
  })

  test('links the UDRP and the transfer dispute policy', async ({ page }) => {
    await page.goto('/')
    const footer = page.getByRole('contentinfo')
    await expect(footer.getByRole('link', { name: /dispute-resolution policy/i })).toBeVisible()
    await expect(footer.getByRole('link', { name: /transfer dispute/i })).toBeVisible()
  })

  /** CMP-3 — we must never present ourselves as ICANN-accredited. */
  test('describes us as a reseller, never as accredited', async ({ page }) => {
    await page.goto('/')
    const text = (await page.getByRole('contentinfo').innerText()).toLowerCase()
    expect(text).toContain('authorised reseller')
    expect(text).not.toMatch(/we are icann[- ]accredited/)
    // The registrar is accredited; we say plainly that we are not.
    expect(text).toContain('not itself icann-accredited')
  })
})

test.describe('FAQ', () => {
  test('answers are collapsed until asked for, then expand', async ({ page }) => {
    await page.goto('/')

    const question = page.getByRole('button', { name: /do i need hosting/i })
    await expect(question).toHaveAttribute('aria-expanded', 'false')

    await question.click()
    await expect(question).toHaveAttribute('aria-expanded', 'true')
    await expect(
      page.getByText(/you can register a domain and point it somewhere later/i),
    ).toBeVisible()
  })
})

test.describe('full page accessibility', () => {
  test('no violations across the whole page', async ({ page }) => {
    await page.goto('/')
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })

  test('no violations in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    const results = await new AxeBuilder({ page }).withTags(['wcag2aa']).analyze()
    expect(results.violations).toEqual([])
  })
})

test.describe('long-page responsiveness', () => {
  test('no horizontal overflow anywhere down the page', async ({ page }) => {
    await page.goto('/')

    for (const width of [320, 375, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(150)

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )
      expect(overflows, `horizontal overflow at ${width}px`).toBe(false)
    }
  })

  test('the shell fills a wide viewport instead of floating in a void', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await page.goto('/')

    const card = await page.locator('main').first().boundingBox()
    expect(card).not.toBeNull()
    // The card should use most of the viewport, not sit at a fixed narrow width.
    expect(card?.width ?? 0).toBeGreaterThan(1600)
  })
})

test.describe('shell containment', () => {
  /**
   * Regression: the header is absolutely positioned so the hero can sit inside
   * <main>. When the shell card was not itself a containing block, the header
   * resolved against the viewport and the logo and Login button spilled onto
   * the canvas either side of the card.
   */
  for (const width of [1280, 1440, 1680, 1920, 2560]) {
    test(`the header stays inside the card at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')

      const card = await page.locator('main').first().boundingBox()
      const header = await page.getByRole('banner').boundingBox()
      expect(card).not.toBeNull()
      expect(header).not.toBeNull()

      expect(Math.round(header?.x ?? -1)).toBe(Math.round(card?.x ?? -2))
      expect(Math.round(header?.width ?? -1)).toBe(Math.round(card?.width ?? -2))
    })
  }

  test('the logo and the Login button sit within the card, not on the canvas', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.goto('/')

    const card = await page.locator('main').first().boundingBox()
    const logo = await page.getByRole('banner').getByRole('link').first().boundingBox()
    const login = await page.getByRole('banner').getByRole('link', { name: 'Login' }).boundingBox()

    expect(logo?.x ?? 0).toBeGreaterThan(card?.x ?? 0)
    expect((login?.x ?? 0) + (login?.width ?? 0)).toBeLessThan((card?.x ?? 0) + (card?.width ?? 0))
  })

  test('content uses the card width rather than a narrow inner column', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.goto('/')

    const card = await page.locator('main').first().boundingBox()
    const stats = await page.getByText('Extensions available').boundingBox()
    const lastStat = await page.getByText('Hidden fees at checkout').boundingBox()

    // The stats row should span most of the card, not huddle in the middle.
    const spanned = (lastStat?.x ?? 0) + (lastStat?.width ?? 0) - (stats?.x ?? 0)
    expect(spanned).toBeGreaterThan((card?.width ?? 0) * 0.8)
  })
})

test.describe('horizontal alignment', () => {
  /**
   * Every section shares one gutter. This caught the header carrying its own
   * padding (lg:px-12) while the rest of the page used Container
   * (lg:px-14 2xl:px-20) — a 52px drift that put the logo and Login button out
   * of line with everything below them.
   *
   * Anything that sets its own horizontal padding instead of using Container
   * will fail here.
   */
  const leftEdge = (
    label: string,
    locate: (
      p: import('@playwright/test').Page,
    ) => ReturnType<import('@playwright/test').Page['locator']>,
  ) => ({ label, locate })

  const ANCHORS = [
    leftEdge('header logo', (p) => p.getByRole('banner').getByRole('link').first()),
    leftEdge('hero heading', (p) => p.getByRole('heading', { level: 1 })),
    leftEdge('stats', (p) => p.getByText('Extensions available')),
    leftEdge('popular extensions', (p) => p.getByRole('heading', { name: 'Popular extensions' })),
    leftEdge('how it works', (p) => p.getByRole('heading', { name: 'Three steps, no tutorial' })),
    leftEdge('why us', (p) =>
      p.getByRole('heading', { name: 'Built for how domains are actually bought in Nigeria' }),
    ),
    leftEdge('faq', (p) => p.getByRole('heading', { name: 'Questions people actually ask' })),
    leftEdge('footer tagline', (p) => p.getByText('Domain registration for Nigeria.')),
  ]

  for (const width of [1280, 1440, 1920, 2560]) {
    test(`every section shares the same left gutter at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')

      const measured: Record<string, number> = {}
      for (const anchor of ANCHORS) {
        const box = await anchor.locate(page).first().boundingBox()
        expect(box, `${anchor.label} not found`).not.toBeNull()
        measured[anchor.label] = Math.round(box?.x ?? -1)
      }

      const unique = [...new Set(Object.values(measured))]
      expect(unique, `left edges differ: ${JSON.stringify(measured)}`).toHaveLength(1)
    })
  }

  test('the header right edge matches the content right edge', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.goto('/')

    const login = await page.getByRole('banner').getByRole('link', { name: 'Login' }).boundingBox()
    const trending = await page.getByRole('heading', { name: 'Also worth a look' }).boundingBox()

    // Trending's section is the rightmost content column on the page.
    const section = await page
      .locator('section', { has: page.getByRole('heading', { name: 'Also worth a look' }) })
      .boundingBox()

    expect(Math.round((login?.x ?? 0) + (login?.width ?? 0))).toBe(
      Math.round((section?.x ?? 0) + (section?.width ?? 0)),
    )
    expect(trending).not.toBeNull()
  })
})
