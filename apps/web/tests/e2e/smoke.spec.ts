import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.describe('home page', () => {
  test('renders the search hero', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/priced in naira/i)
  })

  test('provides a skip link that moves focus to the main content', async ({
    page,
    browserName,
  }) => {
    await page.goto('/')
    const skip = page.getByRole('link', { name: /skip to content/i })

    // WebKit does not tab to links unless the user enables "Press Tab to
    // highlight each item on a webpage", so assert tab order only where it
    // reflects the default experience.
    if (browserName === 'chromium' || browserName === 'firefox') {
      await page.keyboard.press('Tab')
      await expect(skip).toBeFocused()
    }

    await skip.focus()
    await expect(skip).toBeFocused()
    await expect(skip).toHaveAttribute('href', '#main')
    await expect(page.locator('#main')).toBeAttached()
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

test.describe('home page search', () => {
  test('searching navigates to the results page with a canonical query', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('form', { name: 'Domain search', exact: true }).waitFor()
    await page
      .getByRole('form', { name: 'Domain search', exact: true })
      .getByLabel('Find your domain')
      .fill('  https://GetPaid.COM.NG/  ')
    await page
      .getByRole('form', { name: 'Domain search', exact: true })
      .getByRole('button', { name: /search/i })
      .click()
    await expect(page).toHaveURL(/\/search\?q=getpaid\.com\.ng$/)
  })

  test('pressing Enter submits, which is how most people search', async ({ page }) => {
    await page.goto('/')
    const form = page.getByRole('form', { name: 'Domain search', exact: true })
    await form.waitFor()

    const field = form.getByLabel('Find your domain')
    await field.click()
    await field.pressSequentially('getpaid.ng')
    await field.press('Enter')

    await expect(page).toHaveURL(/\/search\?q=getpaid\.ng$/)
  })

  test('a value set without a change event still submits', async ({ page }) => {
    // Browser autofill and password managers set input.value directly. A
    // controlled input would be reset to empty state before submit.
    await page.goto('/')
    const form = page.getByRole('form', { name: 'Domain search', exact: true })
    await form.waitFor()

    await form.getByLabel('Find your domain').evaluate((el) => {
      ;(el as HTMLInputElement).value = 'autofilled.ng'
    })
    await form.getByRole('button', { name: /search/i }).click()

    await expect(page).toHaveURL(/\/search\?q=autofilled\.ng$/)
  })

  test('an empty search explains itself instead of navigating', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('form', { name: 'Domain search', exact: true }).waitFor()
    await page
      .getByRole('form', { name: 'Domain search', exact: true })
      .getByRole('button', { name: /search/i })
      .click()

    // Scope to the form: Next injects its own role="alert" route announcer,
    // so a bare getByRole('alert') is ambiguous.
    const formAlert = page
      .getByRole('form', { name: 'Domain search', exact: true })
      .getByRole('alert')
    await expect(formAlert).toContainText(/type a name/i)
    await expect(page).toHaveURL(/\/$/)
  })
})

test.describe('pricing transparency', () => {
  /** PRD N8 — a price is never shown without its renewal price. */
  test('every featured extension shows a renewal price', async ({ page }) => {
    await page.goto('/')
    const cards = page.getByRole('heading', { name: 'Popular extensions' })
    await expect(cards).toBeVisible()

    const renewals = page.getByText(/Renews at/i)
    await expect(renewals.first()).toBeVisible()
    expect(await renewals.count()).toBeGreaterThanOrEqual(3)
  })
})

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the menu button opens and closes the nav', async ({ page }) => {
    await page.goto('/')
    const toggle = page.getByRole('button', { name: /open menu/i })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await toggle.click()
    await expect(page.getByRole('button', { name: /close menu/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeVisible()
  })

  test('the hero visual never overlaps the search field', async ({ page }) => {
    await page.goto('/')
    const search = await page
      .getByRole('form', { name: 'Domain search', exact: true })
      .getByLabel('Find your domain')
      .boundingBox()
    const card = await page.getByText('getpaid.ng').boundingBox()
    expect(search).not.toBeNull()
    expect(card).not.toBeNull()
    // The result card sits strictly below the search pill.
    expect(card?.y ?? 0).toBeGreaterThan((search?.y ?? 0) + (search?.height ?? 0))
  })
})

test.describe('progressive enhancement', () => {
  test.use({ javaScriptEnabled: false })

  test('search still works with JavaScript disabled', async ({ page }) => {
    await page.goto('/')
    await page
      .getByRole('form', { name: 'Domain search', exact: true })
      .getByLabel('Find your domain')
      .fill('getpaid.ng')
    await page
      .getByRole('form', { name: 'Domain search', exact: true })
      .getByRole('button', { name: /search/i })
      .click()
    await expect(page).toHaveURL(/\/search\?q=getpaid\.ng$/)
  })
})
