import { expect, test } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { publicSupabaseEnv } from './support/public-pages'

/**
 * The pricing page against the rows it reads (MAIL-SPEC §8, N5b): the plans
 * offered, in order, each price and cap equal to its `mail.plans` row, Scale
 * absent while `is_offered` is false, and the structured data repeating the
 * page — read as anon reads them, through the publishable key.
 */

type Row = {
  code: string
  name: string
  price_kobo: number
  monthly_cap: number
  daily_cap: number
  max_domains: number
  max_members: number
  log_retention_days: number
  is_offered: boolean
  sort_order: number
}

async function planRows(): Promise<Row[]> {
  const { url, key } = publicSupabaseEnv()
  const db = createClient(url, key, {
    db: { schema: 'mail' },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await db
    .from('plans')
    .select(
      'code, name, price_kobo, monthly_cap, daily_cap, max_domains, max_members, log_retention_days, is_offered, sort_order',
    )
    .order('sort_order')
  if (error) throw new Error(error.message)
  return data as Row[]
}

const count = (n: number) => new Intl.NumberFormat('en-NG').format(n)
const kobo = (text: string) => Number(text.replace(/[^\d]/g, '')) * 100
const decimal = (k: number) => `${Math.trunc(k / 100)}.${String(k % 100).padStart(2, '0')}`

test('every price and cap on the page is its plans row; Scale is not offered', async ({ page }) => {
  const rows = await planRows()
  const offered = rows.filter((row) => row.is_offered)
  expect(offered.length).toBeGreaterThan(0)

  await page.goto('/pricing')
  const cards = page.getByRole('list', { name: 'Plans' }).locator('[data-plan]')
  await expect(cards).toHaveCount(offered.length)
  expect(await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-plan')))).toEqual(
    offered.map((row) => row.code),
  )

  for (const row of offered) {
    const card = page.locator(`[data-plan="${row.code}"]`)
    await expect(card.getByRole('heading', { level: 3 })).toHaveText(row.name)
    expect(kobo(await card.getByTestId('plan-price').innerText()), row.code).toBe(row.price_kobo)
    await expect(card).toContainText(`${count(row.monthly_cap)} email`)
    await expect(card).toContainText(`Up to ${count(row.daily_cap)} a day`)
    await expect(card).toContainText(`${count(row.max_domains)} sending domain`)
    await expect(card).toContainText(`${count(row.max_members)} team member`)
    await expect(card).toContainText(`Email log kept ${count(row.log_retention_days)} day`)
  }

  for (const row of rows.filter((r) => !r.is_offered)) {
    await expect(page.locator(`[data-plan="${row.code}"]`)).toHaveCount(0)
    await expect(page.getByRole('main')).not.toContainText(row.name)
  }
  await expect(page.getByRole('main')).toContainText('VAT 7.5% is added at checkout')
})

test('says what happens at 80% and 100% of a cap, and that caps count recipients', async ({
  page,
}) => {
  await page.goto('/pricing')
  const caps = page.getByRole('region', { name: 'What happens at a cap' })
  await expect(caps).toContainText('At 80% of a cap')
  await expect(caps).toContainText('At 100% of a cap')
  await expect(caps).toContainText('quota_exceeded (HTTP 429)')
  await expect(caps).toContainText('An email to three people counts as three')
})

test('FAQ answers are in the HTML a crawler reads, closed or not', async ({ request }) => {
  const html = await (await request.get('/pricing')).text()
  expect(html).toContain('Message bodies are deleted 72 hours after sending.')
  expect(html).toContain('There is no overage billing.')
})

test('the structured data repeats the page’s prices, and nothing the page does not say', async ({
  page,
}) => {
  const offered = (await planRows()).filter((row) => row.is_offered)
  await page.goto('/pricing')
  const graphs = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((els) => els.map((el) => JSON.parse(el.textContent ?? '{}')))
  const nodes = graphs.flatMap((graph) => graph['@graph'] ?? [])
  const service = nodes.find((node: { '@type': string }) => node['@type'] === 'Service')
  expect(service.offers.map((offer: { price: string }) => offer.price)).toEqual(
    offered.map((row) => decimal(row.price_kobo)),
  )
  for (const offer of service.offers) {
    expect(offer).not.toHaveProperty('availability')
    expect(offer.priceSpecification.valueAddedTaxIncluded).toBe(false)
  }
  const faq = nodes.find((node: { '@type': string }) => node['@type'] === 'FAQPage')
  for (const question of faq.mainEntity) {
    await expect(page.getByRole('button', { name: question.name, exact: true })).toBeVisible()
  }
  expect(JSON.stringify(nodes)).not.toContain('aggregateRating')
})
