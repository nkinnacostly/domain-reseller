import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'
import { SUPABASE_URL } from '../../../../tests/mocks/supabase'
import { getPlanCatalogue, loadPlanCatalogue, PLANS_TAG } from '../queries/plans'
import { ROWS } from './fixtures'

const cache = vi.hoisted(() => ({ tags: [] as string[], lives: [] as string[] }))
vi.mock('next/cache', () => ({
  cacheTag: (tag: string) => cache.tags.push(tag),
  cacheLife: (life: string) => cache.lives.push(life),
}))

type Seen = { url: URL; profile: string | null; auth: string | null }

function answerPlans(answer: () => Response) {
  const seen: Seen[] = []
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/plans`, ({ request }) => {
      seen.push({
        url: new URL(request.url),
        profile: request.headers.get('accept-profile'),
        auth: request.headers.get('authorization'),
      })
      return answer()
    }),
  )
  return seen
}

describe('reading the plans (cookie-free, cached)', () => {
  it('asks schema mail for the offered plans in order, as anon, and tags the cache', async () => {
    const seen = answerPlans(() => HttpResponse.json(ROWS.filter((row) => row.is_offered)))
    const catalogue = await loadPlanCatalogue()
    expect(catalogue.plans.map((plan) => plan.code)).toEqual(['free', 'starter', 'pro'])
    expect(seen).toHaveLength(1)
    const [request] = seen
    expect(request?.profile).toBe('mail')
    expect(request?.url.searchParams.get('is_offered')).toBe('eq.true')
    expect(request?.url.searchParams.get('order')).toBe('sort_order.asc')
    expect(request?.url.searchParams.get('select')).toContain('price_kobo')
    // The publishable key, never a session: nothing here reads cookies.
    expect(request?.auth ?? '').not.toContain('sb_test')
    expect(cache.tags).toContain(PLANS_TAG)
    expect(cache.lives).toContain('hours')
  })

  it('never shows a plan the database marks not offered, even if one comes back', async () => {
    answerPlans(() => HttpResponse.json(ROWS))
    const catalogue = await getPlanCatalogue()
    expect(catalogue?.plans.map((plan) => plan.name)).not.toContain('Scale')
  })

  it('withholds prices when the read fails, rather than guess (N5b)', async () => {
    answerPlans(() =>
      HttpResponse.json({ code: 'PGRST106', message: 'schema not exposed' }, { status: 406 }),
    )
    await expect(loadPlanCatalogue()).rejects.toThrow(/^plans: /)
    expect(await getPlanCatalogue()).toBeNull()
  })

  it('an empty answer is no plans, not an error', async () => {
    answerPlans(() => HttpResponse.json([]))
    expect(await getPlanCatalogue()).toEqual({ plans: [], updatedAt: null })
  })
})
