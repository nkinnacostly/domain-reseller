import { AI_FEATURES } from '@dr/shared/ai'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FEATURE_LABEL,
  NOT_MEASURED,
  pointedWords,
  SPEND_HIDDEN,
  screeningWords,
  shareWords,
} from '@/features/admin/lib/ai-copy'
import {
  type AiFeatureRow,
  type AiReport,
  dailySeries,
  outcomes,
  parseAiReport,
  percent,
  usdFromMicro,
} from '@/features/admin/lib/ai-report'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

const { getAiReport, watWindow } = await import('@/features/admin/queries/ai')
const { AiPanels } = await import('@/features/admin/components/ai/ai-view')

const feature = (name: string, overrides: Partial<AiFeatureRow> = {}): AiFeatureRow => ({
  feature: name,
  calls: 10,
  failed: 1,
  declined: 2,
  promptTokens: 9_000,
  cachedTokens: 6_000,
  completionTokens: 1_200,
  costMicro: 4_321,
  ...overrides,
})

const REPORT: AiReport = {
  spend: {
    monthMicro: 61_234_567,
    budgetCents: 5_000,
    since: '2026-11-26T07:00:00+00:00',
    features: [
      feature('name_finder', { costMicro: 1_250_000 }),
      feature('help_answer'),
      feature('site_assistant', { calls: 12, failed: 1, declined: 3 }),
    ],
    daily: [{ day: '2026-11-25', costMicro: 1_254_321 }],
  },
  lines: { paid: 40, nameFinder: 3, assistantLink: 2, siteAssistant: 6 },
  delegation: { registered: 20, verifiedIn7: 9 },
  screening: { screened: 38, flagged: 2, waiting: 1 },
  bulk: { agencies: 4, current: 7, prior: 3 },
}

function rpcAnswers(data: unknown, error: { code: string } | null = null) {
  const rpc = vi.fn(async () => ({ data, error }))
  vi.mocked(createClient).mockResolvedValue({ rpc } as never)
  return rpc
}

beforeEach(() => vi.clearAllMocks())

describe('the AI report (migration 75)', () => {
  it('takes only the shape SQL answers', () => {
    expect(parseAiReport(REPORT)).toEqual(REPORT)
    expect(parseAiReport({ ...REPORT, spend: null })?.spend).toBeNull()
    expect(
      parseAiReport({
        ...REPORT,
        lines: { paid: -1, nameFinder: 0, assistantLink: 0, siteAssistant: 0 },
      }),
    ).toBeNull()
    // Migration 76's count is part of the shape: an answer without it is no answer.
    expect(
      parseAiReport({ ...REPORT, lines: { paid: 40, nameFinder: 3, assistantLink: 2 } }),
    ).toBeNull()
    expect(parseAiReport({ ...REPORT, bulk: undefined })).toBeNull()
  })

  it('shows money rounded up to the cent, never below what it may be', () => {
    expect(usdFromMicro(0)).toBe('$0.00')
    expect(usdFromMicro(1)).toBe('under $0.01')
    expect(usdFromMicro(10_000)).toBe('$0.01')
    expect(usdFromMicro(10_001)).toBe('$0.02')
    expect(usdFromMicro(61_234_567)).toBe('$61.24')
    expect(percent(9, 20)).toBe('45%')
    expect(percent(1, 0)).toBeNull()
  })

  it('splits a feature’s calls, and fills quiet days with nothing', () => {
    expect(outcomes(feature('x'))).toEqual({ calls: 10, answered: 7, declined: 2, failed: 1 })
    expect(outcomes(undefined)).toEqual({ calls: 0, answered: 0, declined: 0, failed: 0 })
    expect(dailySeries([{ day: '2026-11-25', costMicro: 5 }], '2026-11-24', '2026-11-26')).toEqual([
      { day: '2026-11-24', costMicro: 0 },
      { day: '2026-11-25', costMicro: 5 },
      { day: '2026-11-26', costMicro: 0 },
    ])
  })

  it('names every feature that is counted', () => {
    expect(Object.keys(FEATURE_LABEL).sort()).toEqual([...AI_FEATURES].sort())
  })

  it('reads 30 WAT days, today included, for the side shown', async () => {
    // 23:30 UTC on the 25th is 00:30 WAT on the 26th.
    expect(watWindow(new Date('2026-11-25T23:30:00Z'), 30)).toEqual({
      from: '2026-10-28',
      to: '2026-11-26',
    })
    const rpc = rpcAnswers(REPORT)
    expect(await getAiReport('test', { from: '2026-10-28', to: '2026-11-26' })).toEqual(REPORT)
    expect(rpc).toHaveBeenCalledWith('admin_ai_report', {
      p_test_mode: true,
      p_from: '2026-10-28',
      p_to: '2026-11-26',
    })
    rpcAnswers(null, { code: '42501' })
    expect(await getAiReport('live', { from: '2026-10-28', to: '2026-11-26' })).toBeNull()
    rpcAnswers({ spend: 'lots' })
    expect(await getAiReport('live', { from: '2026-10-28', to: '2026-11-26' })).toBeNull()
  })
})

describe('the AI page', () => {
  it('shows the month against the budget, the cost by feature, and each phase’s measure', async () => {
    rpcAnswers(REPORT)
    render(await AiPanels({ side: 'live', now: new Date('2026-11-26T10:00:00Z') }))

    const spend = screen.getByRole('region', { name: 'Spend' })
    expect(within(spend).getAllByText('$61.24').length).toBeGreaterThan(0)
    expect(within(spend).getByText(/of the \$50\.00 monthly budget/)).toBeInTheDocument()
    expect(
      within(spend).getByRole('link', { name: 'Change the budget in Settings' }),
    ).toHaveAttribute('href', '/admin/settings')
    expect(within(spend).getByRole('img', { name: /Estimated AI cost by day/ })).toBeInTheDocument()
    expect(within(spend).getAllByText('Name finder').length).toBeGreaterThan(0)
    expect(
      within(spend).getByText(/DeepSeek's own dashboard has the exact bill/),
    ).toBeInTheDocument()

    const impact = screen.getByRole('region', { name: 'Is it working?' })
    expect(within(impact).getByText('3 of 40 paid new domains (8%)')).toBeInTheDocument()
    expect(within(impact).getByText('2 of 40 paid new domains (5%)')).toBeInTheDocument()
    expect(within(impact).getByText(/45% — 9 of 20 domains/)).toBeInTheDocument()
    expect(
      within(impact).getByText(/10 asked: 7 answered from the help pages, 2 pointed to email/),
    ).toBeInTheDocument()
    expect(
      within(impact).getByText(/7 in the last 30 days, 3 in the 30 before, from 4 accounts/),
    ).toBeInTheDocument()
    expect(within(impact).getByText(NOT_MEASURED.searchConversion)).toBeInTheDocument()
    expect(within(impact).getByText(NOT_MEASURED.supportEmails)).toBeInTheDocument()
    // AI phase 5: the site assistant's lines and its messages.
    const five = within(impact).getByRole('region', {
      name: 'Phase 5 — one assistant on every page',
    })
    expect(within(five).getByText('6 of 40 paid new domains (15%)')).toBeInTheDocument()
    expect(
      within(five).getByText(
        '12 messages: 8 answered, 3 it could not help with, 1 with no answer.',
      ),
    ).toBeInTheDocument()
  })

  it('gives a test administrator no spend and no usage, and says so', async () => {
    rpcAnswers({ ...REPORT, spend: null })
    render(await AiPanels({ side: 'test', now: new Date('2026-11-26T10:00:00Z') }))
    expect(screen.queryByText(/\$61\.24/)).not.toBeInTheDocument()
    expect(screen.getAllByText(SPEND_HIDDEN).length).toBe(5)
    expect(screen.getByText('3 of 40 paid new domains (8%)')).toBeInTheDocument()
  })

  it('says when nothing has been counted, and when the report cannot be read', async () => {
    rpcAnswers({ ...REPORT, spend: { ...REPORT.spend, features: [], daily: [], monthMicro: 0 } })
    render(await AiPanels({ side: 'live', now: new Date('2026-11-26T10:00:00Z') }))
    expect(screen.getByText(/No AI calls counted yet/)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /Estimated AI cost by day/ })).not.toBeInTheDocument()

    rpcAnswers(null, { code: 'PGRST' })
    const { container } = render(await AiPanels({ side: 'live', now: new Date() }))
    expect(within(container).getByText("The AI figures couldn't be loaded.")).toBeInTheDocument()
  })
})

describe('the AI page’s words', () => {
  it('never divides by nothing', () => {
    expect(shareWords(0, 0, 'paid new domains')).toBe(
      'None — no paid new domains in the last 30 days.',
    )
    expect(pointedWords(0, 0)).toMatch(/^No domains were registered/)
    expect(screeningWords(0, 0, 0)).toBe('No new names screened.')
    expect(screeningWords(5, 1, 0)).toMatch(/every flagged name has a decision/)
  })
})
