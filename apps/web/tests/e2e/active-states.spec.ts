import { expect, type Page, test } from '@playwright/test'

/**
 * The header nav for this viewport. Below `md` the Main nav is hidden and the
 * same links live in the menu, marked with a side rule (::before) instead of
 * an underline (::after).
 */
async function headerNav(page: Page) {
  const main = page.getByRole('banner').getByRole('navigation', { name: 'Main' })
  if (await main.isVisible()) return { nav: main, marker: '::after' }

  await page.getByRole('button', { name: 'Open menu' }).click()
  return {
    nav: page.getByRole('banner').getByRole('navigation', { name: 'Mobile' }),
    marker: '::before',
  }
}

test.describe('current page indicator', () => {
  test('marks the nav link for the page you are on', async ({ page }) => {
    await page.goto('/pricing')

    const { nav } = await headerNav(page)
    await expect(nav.getByRole('link', { name: 'Pricing' })).toHaveAttribute('aria-current', 'page')
  })

  test('leaves the other links unmarked', async ({ page }) => {
    await page.goto('/pricing')

    const { nav } = await headerNav(page)
    for (const label of ['How it works', 'Transfer']) {
      await expect(nav.getByRole('link', { name: label })).not.toHaveAttribute('aria-current', /.*/)
    }
  })

  test('marks nothing on the home page, since a jump link is not a page', async ({ page }) => {
    await page.goto('/')
    const marked = page.getByRole('banner').locator('a[aria-current]')
    await expect(marked).toHaveCount(0)
  })

  test('marks the matching footer link too', async ({ page }) => {
    await page.goto('/pricing')
    const footerNav = page.getByRole('contentinfo').getByRole('navigation', { name: 'Footer' })
    await expect(footerNav.getByRole('link', { name: 'Pricing' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  /**
   * Colour alone is not an acceptable signal (WCAG 1.4.1). The current link
   * carries a rule beneath it, drawn as an ::after pseudo-element.
   */
  test('signals the current link with more than colour', async ({ page }) => {
    await page.goto('/pricing')

    const { nav, marker } = await headerNav(page)
    const current = nav.getByRole('link', { name: 'Pricing' })

    const indicator = await current.evaluate((el, pseudo) => {
      const rule = getComputedStyle(el, pseudo)
      return { content: rule.content, height: rule.height, background: rule.backgroundColor }
    }, marker)

    expect(indicator.content).not.toBe('none')
    expect(Number.parseFloat(indicator.height)).toBeGreaterThan(0)
  })

  test('updates when you navigate', async ({ page }) => {
    await page.goto('/')
    await (await headerNav(page)).nav.getByRole('link', { name: 'Pricing' }).click()
    await expect(page).toHaveURL(/\/pricing$/)

    const { nav } = await headerNav(page)
    await expect(nav.getByRole('link', { name: 'Pricing' })).toHaveAttribute('aria-current', 'page')
  })
})

test.describe('pressed feedback', () => {
  /**
   * Without a pressed state a tap gives no acknowledgement until the next
   * paint. On a slow connection that reads as "nothing happened" and invites a
   * second tap — on a checkout button, that is a duplicate order.
   */
  test('a button visibly responds while held down', async ({ page }) => {
    await page.goto('/')
    const button = page
      .getByRole('form', { name: 'Domain search', exact: true })
      .getByRole('button', { name: /search/i })

    const box = await button.boundingBox()
    expect(box).not.toBeNull()

    const resting = await button.evaluate((el) => getComputedStyle(el).transform)

    await page.mouse.move(
      (box?.x ?? 0) + (box?.width ?? 0) / 2,
      (box?.y ?? 0) + (box?.height ?? 0) / 2,
    )
    await page.mouse.down()
    const pressed = await button.evaluate((el) => getComputedStyle(el).transform)
    await page.mouse.up()

    expect(pressed).not.toBe(resting)
  })

  test('a disabled control shows it is unavailable', async ({ page }) => {
    await page.goto('/')
    const cursor = await page.evaluate(() => {
      const probe = document.createElement('button')
      probe.disabled = true
      document.body.append(probe)
      const value = getComputedStyle(probe).cursor
      probe.remove()
      return value
    })
    expect(cursor).toBe('not-allowed')
  })
})

test.describe('hover feedback', () => {
  /**
   * Touch screens have no hover: Tailwind 4 gates `hover:` behind
   * `(hover: hover)`, so a tap never leaves a row stuck highlighted. Only
   * pointer devices can be asserted here.
   */
  test('a pricing table row responds to the pointer', async ({ page, hasTouch }) => {
    test.skip(hasTouch, 'no hover on touch screens, by design')
    await page.goto('/pricing')
    const row = page.locator('tbody tr').first()

    const resting = await row.evaluate((el) => getComputedStyle(el).backgroundColor)
    await row.hover()
    const hovered = await row.evaluate((el) => getComputedStyle(el).backgroundColor)

    expect(hovered).not.toBe(resting)
  })
})
