import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.describe('homepage structure', () => {
  test('has one h1 and a heading for every section', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)

    // Scoped to main: the footer has its own headings.
    const main = page.locator('main')
    for (const heading of [
      'Three steps, no tutorial',
      'Search once, see both prices',
      'Pay in naira, your way',
      'Point it at your host',
      'Why choose MyDomainsHub?',
      'Popular extensions',
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
    // The theme follows the stored choice, not the OS, so set it directly.
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'))
    await page.goto('/')
    await expect(page.locator('html')).toHaveClass(/dark/)
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

  /**
   * The site has no floating card: it is a plain page, and the grey-teal
   * canvas it used to sit on must not come back round the edges.
   */
  test('the page is plain background edge to edge, with no card canvas', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')

    const [corner, background] = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--background)'
      document.body.append(probe)
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      // Inside the margin between the viewport edge and the blue hero.
      const el = document.elementFromPoint(3, 3)
      let node: Element | null = el
      while (node && getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)') {
        node = node.parentElement
      }
      return [node ? getComputedStyle(node).backgroundColor : '', expected]
    })
    expect(corner).toBe(background)
  })
})

test.describe('hero panel', () => {
  /**
   * Regression guard for the floated header: it sits outside <main> so it
   * stays a banner landmark, and is positioned over the blue hero. If the
   * page wrapper stops being its containing block, the logo and Login button
   * land on the white page instead of the panel.
   */
  for (const width of [375, 768, 1280, 1440, 1920, 2560]) {
    test(`the header sits on the blue panel at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')

      const panel = await page.getByTestId('hero-panel').boundingBox()
      const logo = await page.getByRole('banner').getByRole('link').first().boundingBox()
      expect(panel).not.toBeNull()
      expect(logo).not.toBeNull()

      const inside = (box: typeof logo) =>
        (box?.x ?? -1) > (panel?.x ?? 0) &&
        (box?.y ?? -1) > (panel?.y ?? 0) &&
        (box?.x ?? 0) + (box?.width ?? 0) < (panel?.x ?? 0) + (panel?.width ?? 0)
      expect(inside(logo), 'logo is off the panel').toBe(true)

      if (width >= 640) {
        const login = await page
          .getByRole('banner')
          .getByRole('link', { name: 'Login' })
          .boundingBox()
        expect(inside(login), 'Login is off the panel').toBe(true)
      }
    })
  }

  test('the phone mockup is clipped by the panel, not spilling onto the page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    const panel = await page.getByTestId('hero-panel').boundingBox()
    const stats = await page.getByRole('region', { name: 'At a glance' }).boundingBox()
    // Nothing from the hero overlaps the stats row below it.
    expect((stats?.y ?? 0) + 1).toBeGreaterThanOrEqual((panel?.y ?? 0) + (panel?.height ?? 0))
  })
})

test.describe('horizontal alignment', () => {
  /**
   * Every section shares one gutter (S4). The blue hero is wider than the
   * content, so what must line up is what sits on it — the header — with
   * everything below. Anything that sets its own horizontal padding instead
   * of using Container will fail here.
   */
  const leftEdge = (
    label: string,
    locate: (
      p: import('@playwright/test').Page,
    ) => ReturnType<import('@playwright/test').Page['locator']>,
  ) => ({ label, locate })

  const section = (p: import('@playwright/test').Page, heading: string) =>
    p.locator('section', { has: p.getByRole('heading', { name: heading, exact: true }) })

  const ANCHORS = [
    leftEdge('header logo', (p) => p.getByRole('banner').getByRole('link').first()),
    leftEdge('stats', (p) => p.getByRole('region', { name: 'At a glance' }).locator('dl')),
    leftEdge('step 1', (p) => p.getByRole('heading', { name: 'Search once, see both prices' })),
    leftEdge('why us cards', (p) => section(p, 'Why choose MyDomainsHub?').getByRole('list')),
    leftEdge('popular extensions', (p) =>
      section(p, 'Popular extensions').getByRole('list').first(),
    ),
    leftEdge('faq', (p) => p.getByRole('heading', { name: 'Questions people actually ask' })),
    leftEdge('footer tagline', (p) => p.getByText('Domain registration for Nigeria.')),
  ]

  for (const width of [390, 768, 1280, 1440, 1920, 2560]) {
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
    const cards = await section(page, 'Popular extensions').getByRole('list').first().boundingBox()

    expect(Math.round((login?.x ?? 0) + (login?.width ?? 0))).toBe(
      Math.round((cards?.x ?? 0) + (cards?.width ?? 0)),
    )
  })
})
