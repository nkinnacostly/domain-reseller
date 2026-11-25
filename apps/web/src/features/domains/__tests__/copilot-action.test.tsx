import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '@/lib/env'
import { withinLimit } from '@/lib/rate-limit'
import { createClient } from '@/lib/supabase/server'
import { server } from '../../../../tests/mocks/server'
import { changeNameserversInBulk } from '../actions/bulk'
import { PortfolioCopilot } from '../components/portfolio-copilot'
import type { PortfolioDomain } from '../lib/portfolio'
import { getNameserverPresets, getPortfolio } from '../queries/domains'
import { getLabels } from '../queries/labels'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('../queries/domains', () => ({ getPortfolio: vi.fn(), getNameserverPresets: vi.fn() }))
vi.mock('../queries/labels', () => ({ getLabels: vi.fn() }))
vi.mock('../actions/bulk', () => ({
  changeNameserversInBulk: vi.fn(),
  setAutoRenewInBulk: vi.fn(),
  setPrivacyInBulk: vi.fn(),
  lockTransfersInBulk: vi.fn(),
  unlockTransfersInBulk: vi.fn(),
}))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  withinLimit: vi.fn(),
}))

const { draftPortfolioChange } = await import('../actions/copilot')

const ai = env as { DEEPSEEK_API_KEY?: string }
let key: string | undefined
let sent: string[] = []

function modelAnswers(content: unknown, status = 200) {
  server.use(
    http.post('https://api.deepseek.com/chat/completions', async ({ request }) => {
      sent.push(await request.text())
      if (status !== 200) return HttpResponse.json({}, { status })
      return HttpResponse.json({
        choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 400, completion_tokens: 60 },
      })
    }),
  )
}

const domain = (id: string, name: string, labels: { id: string; name: string }[] = []) =>
  ({
    id,
    domainName: name,
    tld: name.split('.').slice(1).join('.'),
    source: 'registration',
    testMode: false,
    status: 'active',
    expiresAt: '2027-06-01T00:00:00Z',
    autoRenew: false,
    privacyEnabled: true,
    transferLock: true,
    delegationStatus: 'verified',
    nameservers: null,
    pendingNameservers: null,
    labels,
  }) as unknown as PortfolioDomain

const clients = { id: 'l1', name: 'Clients', color: 'blue' }

beforeEach(() => {
  vi.clearAllMocks()
  sent = []
  key = ai.DEEPSEEK_API_KEY
  ai.DEEPSEEK_API_KEY = 'sk-test'
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: 'aal1', nextLevel: 'aal1' },
          error: null,
        }),
      },
    },
  } as never)
  vi.mocked(withinLimit).mockResolvedValue(true)
  vi.mocked(getPortfolio).mockResolvedValue([
    domain('d1', 'getpaid.ng', [clients]),
    domain('d2', 'secret-client.com', [clients]),
    domain('d3', 'mine.ng'),
  ])
  vi.mocked(getLabels).mockResolvedValue([{ ...clients, count: 2 }] as never)
  vi.mocked(getNameserverPresets).mockResolvedValue([
    {
      id: 'p1',
      provider: 'Vercel',
      nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
      assignsPerZone: false,
      notes: null,
      sourceUrl: 'https://vercel.com/docs',
    },
  ])
})
afterEach(() => {
  ai.DEEPSEEK_API_KEY = key
})

describe('draftPortfolioChange (feature 7)', () => {
  it('sends the words masked and the host names, never the account, and drafts from the account', async () => {
    modelAnswers({ action: 'nameservers', host: 'Vercel', select: { label: 'clients' } })
    const result = await draftPortfolioChange({
      instruction: 'Point the Clients ones and getpaid.ng at Vercel, call 08031234567',
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('[domain 1]')
    expect(sent[0]).toContain('Hosts: Vercel')
    expect(sent[0]).not.toMatch(/getpaid|secret-client|mine\.ng|0803/)
    expect(result?.data).toMatchObject({
      ok: true,
      draft: {
        kind: 'draft',
        action: 'nameservers',
        presetId: 'p1',
        domains: [
          { id: 'd1', name: 'getpaid.ng' },
          { id: 'd2', name: 'secret-client.com' },
        ],
      },
    })
  })

  it('says why when the copilot is off, busy or the model fails — and asks nothing when off or busy', async () => {
    modelAnswers({}, 503)
    expect((await draftPortfolioChange({ instruction: 'renew everything' }))?.data).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    vi.mocked(withinLimit).mockResolvedValue(false)
    expect((await draftPortfolioChange({ instruction: 'renew everything' }))?.data).toEqual({
      ok: false,
      reason: 'limited',
    })
    ai.DEEPSEEK_API_KEY = undefined
    expect((await draftPortfolioChange({ instruction: 'renew everything' }))?.data).toEqual({
      ok: false,
      reason: 'off',
    })
    expect(sent).toHaveLength(1)
  })

  it('refuses words too short to act on', async () => {
    expect((await draftPortfolioChange({ instruction: 'go' }))?.validationErrors).toBeDefined()
  })
})

describe('PortfolioCopilot', () => {
  it('drafts, then confirms through the bulk action and opens its results', async () => {
    modelAnswers({ action: 'nameservers', host: 'Vercel', select: { all: true } })
    vi.mocked(changeNameserversInBulk).mockResolvedValue({
      data: { ok: true, operationId: 'op-1', warnings: [] },
    } as never)
    render(<PortfolioCopilot returnTo="/app/domains" />)
    await userEvent.type(
      screen.getByRole('textbox', { name: 'What should happen to your domains?' }),
      'point everything at vercel',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Draft it' }))
    expect(
      await screen.findByText(
        'Point 3 domains at Vercel (ns1.vercel-dns.com, ns2.vercel-dns.com).',
      ),
    ).toBeInTheDocument()
    // Nothing has changed yet: the bulk action runs only on confirm.
    expect(changeNameserversInBulk).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm for 3' }))
    expect(changeNameserversInBulk).toHaveBeenCalledWith({
      domainIds: ['d1', 'd2', 'd3'],
      nameservers: 'ns1.vercel-dns.com\nns2.vercel-dns.com',
      presetId: 'p1',
    })
    expect(push).toHaveBeenCalledWith('/app/domains/bulk/op-1')
  })

  it('shows a renewal as a link to the priced renewal page, and a question as a question', async () => {
    modelAnswers({ action: 'renew', select: { extension: 'ng' } })
    render(<PortfolioCopilot returnTo="/app/domains" />)
    const box = screen.getByRole('textbox', { name: 'What should happen to your domains?' })
    await userEvent.type(box, 'renew my .ng domains')
    await userEvent.click(screen.getByRole('button', { name: 'Draft it' }))
    expect(await screen.findByRole('link', { name: 'Review the renewal' })).toHaveAttribute(
      'href',
      '/app/domains/renew?ids=d1,d3',
    )
    modelAnswers({ action: 'none', question: 'Which domains should I renew?' })
    await userEvent.click(screen.getByRole('button', { name: 'Draft it' }))
    expect(await screen.findByText('Which domains should I renew?')).toBeInTheDocument()
  })

  it('shows a bulk action’s refusal with its details', async () => {
    modelAnswers({
      action: 'nameservers',
      nameservers: ['ns1.bad.example', 'ns2.bad.example'],
      select: { all: true },
    })
    vi.mocked(changeNameserversInBulk).mockResolvedValue({
      data: {
        error: 'Some nameservers need fixing before we can use them.',
        details: ['ns1.bad.example does not exist'],
      },
    } as never)
    render(<PortfolioCopilot returnTo="/app/domains" />)
    await userEvent.type(
      screen.getByRole('textbox', { name: 'What should happen to your domains?' }),
      'use ns1.bad.example',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Draft it' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm for 3' }))
    expect(await screen.findByText('ns1.bad.example does not exist')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })
})
