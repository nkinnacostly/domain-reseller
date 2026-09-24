import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * Being found: by search engines and by AI assistants, most of which read the
 * HTML without running it. So these check what the server sends, not only
 * what a browser shows (features/seo).
 */

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()

const overflows = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )

type Node = Record<string, unknown> & { '@type': string }

/** Every structured-data node on the page. */
const structuredData = async (page: Page): Promise<Node[]> => {
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents()
  return blocks.flatMap((block) => {
    const data = JSON.parse(block)
    return (data['@graph'] ?? [data]) as Node[]
  })
}

/** HTML as a crawler receives it, with scripts removed: what an AI crawler reads. */
const serverText = async (request: import('@playwright/test').APIRequestContext, path: string) => {
  const response = await request.get(path, { headers: { 'User-Agent': 'GPTBot/1.1' } })
  expect(response.ok()).toBe(true)
  return (await response.text()).replace(/<script[\s\S]*?<\/script>/g, '')
}

test.describe('files for crawlers', () => {
  test('robots.txt opens the site, closes the panel and live lookups, and names the sitemap', async ({
    request,
    baseURL,
  }) => {
    const text = await (await request.get('/robots.txt')).text()
    expect(text).toContain('User-Agent: *')
    expect(text).toContain('Disallow: /app/')
    expect(text).toContain('Disallow: /search')
    expect(text).toContain('User-Agent: OAI-SearchBot')
    expect(text).toContain('User-Agent: Claude-SearchBot')
    expect(text).toContain(`Sitemap: ${baseURL}/sitemap.xml`)
  })

  test('the sitemap lists the public pages and the extension pages, and nothing private', async ({
    request,
  }) => {
    const xml = await (await request.get('/sitemap.xml')).text()
    const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (match) => new URL(match[1] ?? '').pathname,
    )
    for (const path of [
      '/',
      '/pricing',
      '/domains',
      '/domains/com',
      '/about',
      '/help',
      '/legal/privacy',
    ]) {
      expect(paths, path).toContain(path)
    }
    expect(paths.filter((path) => path.startsWith('/domains/')).length).toBeGreaterThan(10)
    expect(paths.some((path) => /^\/(app|cart|search$|sign-in)/.test(path))).toBe(false)
  })

  test('llms.txt summarises the site, every price with its renewal price (N8)', async ({
    request,
  }) => {
    const response = await request.get('/llms.txt')
    expect(response.headers()['content-type']).toContain('text/plain')
    const text = await response.text()
    expect(text.startsWith('# MyDomainsHub\n')).toBe(true)
    const prices = text.split('\n').filter((line) => line.includes('for the first year'))
    expect(prices.length).toBeGreaterThan(0)
    for (const line of prices) expect(line).toMatch(/then ₦[\d,]+ a year to renew/)

    const full = await (await request.get('/llms-full.txt')).text()
    expect(full).toContain('## Every extension')
    expect(full).toContain('### How can I pay?')
  })

  test('the IndexNow key is served where the engines look for it', async ({ request }) => {
    const key = '2e9aceee178d9e05ee2da67d9e8a6916'
    expect(await (await request.get(`/${key}.txt`)).text()).toBe(key)
  })
})

test.describe('what a crawler reads', () => {
  test('FAQ answers are in the HTML while closed, and hidden until asked for', async ({
    page,
    request,
  }) => {
    for (const [path, answer] of [
      ['/', 'point it somewhere later'],
      ['/help', 'straight away whether your exact name is free'],
      ['/domains/com', 'You choose the number of years in your cart'],
    ] as const) {
      expect(await serverText(request, path), path).toContain(answer)
    }

    await page.goto('/')
    await expect(page.getByText(/point it somewhere later/)).toBeHidden()
    await page.getByRole('button', { name: /do i need hosting/i }).click()
    await expect(page.getByText(/point it somewhere later/)).toBeVisible()
  })

  test('every page names its canonical address, whatever the query string', async ({ page }) => {
    await page.goto('/pricing?utm_source=test')
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href')
    expect(new URL(canonical ?? '').pathname).toBe('/pricing')
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(1)
  })

  test('results and carts are left out of search indexes', async ({ page }) => {
    for (const path of ['/search?q=example.com', '/cart']) {
      await page.goto(path)
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
    }
  })

  test('the home page says who we are: the organization, the site and its FAQ', async ({
    page,
  }) => {
    await page.goto('/')
    const types = (await structuredData(page)).map((node) => node['@type'])
    expect(types).toEqual(expect.arrayContaining(['OnlineStore', 'WebSite', 'FAQPage']))
  })

  test('an extension page’s markup carries the prices the page shows (N8)', async ({ page }) => {
    await page.goto('/domains/com')
    const intro = await page.getByRole('main').textContent()
    const service = (await structuredData(page)).find((node) => node['@type'] === 'Service') as
      | (Node & { offers: { priceCurrency: string; priceSpecification: { price: string }[] } })
      | undefined
    expect(service?.offers.priceCurrency).toBe('NGN')
    const naira = (price: string) => `₦${Number(price).toLocaleString('en-NG')}`
    const [first, renewal] = service?.offers.priceSpecification ?? []
    expect(intro).toContain(
      `${naira(first?.price ?? '')} for the first year, then ${naira(renewal?.price ?? '')} a year`,
    )

    const trail = (await structuredData(page)).find((node) => node['@type'] === 'BreadcrumbList') as
      | (Node & { itemListElement: { name: string }[] })
      | undefined
    expect(trail?.itemListElement.map((item) => item.name)).toEqual([
      'Home',
      'Domain extensions',
      '.com',
    ])
  })

  test('the pricing table links each extension to its page, and keeps crawlers off its searches', async ({
    page,
  }) => {
    await page.goto('/pricing')
    await expect(page.locator('#tld-com th a')).toHaveAttribute('href', '/domains/com')
    await expect(page.locator('#tld-com td a')).toHaveAttribute('rel', 'nofollow')
  })
})

for (const { path, heading } of [
  { path: '/domains', heading: 'Every extension we sell' },
  { path: '/about', heading: 'About MyDomainsHub' },
]) {
  test(`${path} renders, is accessible and never scrolls sideways`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    expect((await axe(page)).violations).toEqual([])

    await page.setViewportSize({ width: 320, height: 900 })
    expect(await overflows(page), `horizontal overflow at 320px on ${path}`).toBe(false)
  })
}

test('the directory links every extension to its own page', async ({ page }) => {
  await page.goto('/domains')
  const popular = page.getByRole('list', { name: 'Popular extensions' })
  await expect(popular.getByRole('link', { name: '.com', exact: true })).toHaveAttribute(
    'href',
    '/domains/com',
  )
  expect(await page.locator('main a[href^="/domains/"]').count()).toBeGreaterThan(100)
})
