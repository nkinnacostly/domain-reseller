import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { leftEdges, noHorizontalOverflow, WIDE } from './support/public-pages'

/**
 * The docs (MAIL-SPEC §6 "Docs") in the public pages' frame: the blue panel
 * with the header on it, the docs' navigation marking the page you are on
 * (S13), axe clean in both themes, no sideways scroll from 320 to 1920 (S5),
 * one left edge (S4) — and the reference listing every endpoint the OpenAPI
 * document does.
 */

const DOCS = [
  ['/docs', 'Overview'],
  ['/docs/quickstart', 'Quickstart'],
  ['/docs/api', 'API reference'],
  ['/docs/errors', 'Errors'],
  ['/docs/limits', 'Limits'],
  ['/docs/idempotency', 'Idempotency'],
  ['/docs/scheduling', 'Scheduling'],
  ['/docs/statuses', 'Statuses and events'],
  ['/docs/webhooks', 'Webhooks'],
  ['/docs/domains', 'Domains and DNS'],
] as const

for (const [path, title] of DOCS) {
  test(`${path}: the frame, the current page, axe in both themes, every width, one edge`, async ({
    page,
  }) => {
    await page.goto(path)
    const h1 = page.getByRole('heading', { level: 1 })
    await expect(h1).toHaveText(path === '/docs' ? 'Documentation' : title)
    const panel = await page.getByTestId('hero-panel').first().boundingBox()
    const box = await h1.boundingBox()
    expect(box?.y ?? 0).toBeGreaterThan(panel?.y ?? 0)

    const nav = page.getByRole('navigation', { name: 'Docs' })
    await expect(nav.locator('[aria-current="page"]')).toContainText(title)

    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.evaluate((value) => localStorage.setItem('theme', value), theme)
      await page.reload()
      const results = await new AxeBuilder({ page }).analyze()
      expect(results.violations, theme).toEqual([])
    }

    await noHorizontalOverflow(page)
    for (const width of WIDE) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(path)
      const { edges, loose } = await leftEdges(page)
      expect(loose, `blocks in <main> without Container at ${width}px`).toEqual([])
      expect([...new Set(Object.values(edges))], `edges at ${width}px`).toHaveLength(1)
    }
  })
}

test('the reference lists every endpoint the OpenAPI document does', async ({ page, request }) => {
  const response = await request.get('/api/v1/openapi.json')
  expect(response.status()).toBe(200)
  expect(response.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  const doc = (await response.json()) as { paths: Record<string, Record<string, unknown>> }
  await page.goto('/docs/api')
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) {
      await expect(page.locator(`[data-operation="${method.toUpperCase()} ${path}"]`)).toHaveCount(
        1,
      )
    }
  }
})

test('the stubs say they are not written yet', async ({ page }) => {
  await page.goto('/docs/webhooks')
  await expect(page.getByText('Webhooks are not available yet.')).toBeVisible()
  await page.goto('/docs/domains')
  await expect(page.getByText('This guide is being written.')).toBeVisible()
})
