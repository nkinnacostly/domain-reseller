import { expect, test } from '@playwright/test'
import { DOCS_GUIDES, LEGAL_PAGES, PUBLIC_PAGES } from './support/public-pages'

/**
 * What crawlers see (CLAUDE.md §15): robots.txt closes the private paths,
 * the sitemap lists the public pages with true dates only, every public
 * page has its canonical address and share card, and — until launch — asks
 * not to be indexed. The legal drafts say so on the page and in the HTML.
 */

test('robots.txt closes the dashboard, the API and auth, and names the sitemap', async ({
  request,
  baseURL,
}) => {
  const text = await (await request.get('/robots.txt')).text()
  expect(text).toContain('Allow: /')
  for (const path of ['/dashboard', '/api/', '/auth/']) expect(text).toContain(`Disallow: ${path}`)
  expect(text).toContain(`Sitemap: ${baseURL}/sitemap.xml`)
})

test('the sitemap lists every public page, dated only where the date is true', async ({
  request,
}) => {
  const xml = await (await request.get('/sitemap.xml')).text()
  for (const path of PUBLIC_PAGES) expect(xml).toMatch(new RegExp(`<loc>[^<]*${path}</loc>`))
  expect(xml).not.toMatch(/dashboard|sign-in|sign-up/)
  const entry = (path: string) =>
    xml.match(new RegExp(`<url>\\s*<loc>[^<]*${path}</loc>[\\s\\S]*?</url>`))?.[0] ?? ''
  expect(entry('/legal/terms')).toContain('<lastmod>2026-10-05T23:00:00.000Z</lastmod>')
  expect(entry('/docs')).not.toContain('<lastmod>')
  expect(entry('/contact')).not.toContain('<lastmod>')
  for (const path of DOCS_GUIDES) {
    expect(entry(path), path).toContain(path)
    expect(entry(path), path).not.toContain('<lastmod>')
  }
})

for (const path of [...PUBLIC_PAGES, ...DOCS_GUIDES]) {
  test(`${path} has its canonical address and share card, and is not indexed before launch`, async ({
    page,
  }) => {
    await page.goto(path)
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      new RegExp(`${path === '/' ? '/?' : path}$`),
    )
    await expect(page.locator('meta[property="og:image"]').first()).toHaveAttribute(
      'content',
      /\/opengraph-image\.png/,
    )
    await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute(
      'content',
      'MyDomainsHub Mail',
    )
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
  })
}

test('the share image is served', async ({ request }) => {
  const response = await request.get('/opengraph-image.png')
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toBe('image/png')
})

for (const path of [...LEGAL_PAGES, '/legal']) {
  test(`${path} is marked a draft pending legal review, on the page and in the HTML`, async ({
    page,
    request,
  }) => {
    const html = await (await request.get(path)).text()
    expect(html).toContain('<!-- Draft — pending legal review -->')
    await page.goto(path)
    await expect(page.getByText('Draft — pending legal review', { exact: true })).toBeVisible()
  })
}

test('the abuse page reports by email, with the fields to fill in', async ({ page }) => {
  await page.goto('/abuse')
  const link = page.getByRole('link', { name: 'Email an abuse report' })
  const href = (await link.getAttribute('href')) ?? ''
  const url = new URL(href)
  expect(url.protocol).toBe('mailto:')
  expect(url.pathname).toBe('hello@mydomainshub.com')
  expect(url.searchParams.get('subject')).toBe('Abuse report: MyDomainsHub Mail')
  expect(url.searchParams.get('body')).toContain('The full message headers:')
  await expect(page.locator('form')).toHaveCount(0)
})

test('the sub-processors are all named, with Amazon SES in eu-west-2', async ({ page }) => {
  await page.goto('/legal/sub-processors')
  const main = page.getByRole('main')
  for (const name of [
    'Amazon Web Services (Amazon SES)',
    'Supabase',
    'Vercel',
    'Fly.io',
    'Flutterwave',
    'Cloudflare',
  ]) {
    await expect(main.getByText(name, { exact: true }).first()).toBeAttached()
  }
  await expect(main).toContainText('eu-west-2')
})
