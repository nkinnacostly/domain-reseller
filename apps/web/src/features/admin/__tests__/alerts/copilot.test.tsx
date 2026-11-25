import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { cookies, headers } from 'next/headers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askAlertHelp } from '@/features/admin/actions/copilot'
import { AlertHelp } from '@/features/admin/components/alerts/alert-help'
import { COPILOT, copilotButtonLabel, offersTicket } from '@/features/admin/lib/copilot-copy'
import { ADMIN_ERROR_WORDS } from '@/features/admin/lib/errors'
import { env } from '@/lib/env'
import { withinLimit } from '@/lib/rate-limit'
import { createClient } from '@/lib/supabase/server'
import { server } from '../../../../../tests/mocks/server'
import { sessionClient, whoami } from '../foundation/fixtures'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  withinLimit: vi.fn(),
}))

const KEY = '7d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a'
const ask = { alertId: 42, mode: 'ticket' as const, page: 'Supplier ledger', requestKey: KEY }
const ALERT = {
  kind: 'supplier_unexplained_charge',
  severity: 'warning',
  summary: 'A $11.31 debit for vissioncapitals.org has no order; ask ada@gmail.com',
  side: 'live',
  resolved: false,
}

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
        usage: { prompt_tokens: 500, completion_tokens: 80 },
      })
    }),
  )
}

function as(
  role: 'owner' | 'operator' | 'viewer',
  reply: unknown = { ok: true, auditId: 70, alert: ALERT },
) {
  const session = sessionClient({
    rpc: {
      admin_whoami: { data: whoami({ role, label: role }) },
      admin_alert_help: { data: reply },
    },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

beforeEach(() => {
  vi.clearAllMocks()
  sent = []
  key = ai.DEEPSEEK_API_KEY
  ai.DEEPSEEK_API_KEY = 'sk-test'
  vi.mocked(withinLimit).mockResolvedValue(true)
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
  vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: 'live' }), set: vi.fn() } as never)
})
afterEach(() => {
  ai.DEEPSEEK_API_KEY = key
})

describe('askAlertHelp (migration 74)', () => {
  it('audits first, sends the alert with the domain and the email kept back, and puts the name back', async () => {
    const session = as('viewer')
    modelAnswers({
      explanation: 'DomainNameAPI charged for [domain 1] with no order of ours.',
      steps: ['Open the Supplier ledger.', 'Ask support who bought [domain 1].'],
      ticket: { subject: 'Charge for [domain 1]', body: 'Hello,\n\nWho bought [domain 1]?' },
    })
    const result = await askAlertHelp(ask)
    expect(session.rpc).toHaveBeenCalledWith('admin_alert_help', {
      p_alert_id: 42,
      p_mode: 'ticket',
      p_request_key: KEY,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toMatch(/vissioncapitals|gmail/)
    expect(sent[0]).toContain('[domain 1]')
    expect(sent[0]).toContain('Supplier charge with no order')
    expect(result.data).toEqual({
      ok: true,
      auditId: 70,
      data: {
        explanation: 'DomainNameAPI charged for vissioncapitals.org with no order of ours.',
        steps: ['Open the Supplier ledger.', 'Ask support who bought vissioncapitals.org.'],
        ticket: {
          subject: 'Charge for vissioncapitals.org',
          body: 'Hello,\n\nWho bought vissioncapitals.org?',
        },
      },
    })
  })

  it('passes a refusal from SQL on, asking no model', async () => {
    as('viewer', { ok: false, code: 'TEST_ADMIN', auditId: 71 })
    modelAnswers({ explanation: 'x', steps: [] })
    expect((await askAlertHelp(ask)).data).toMatchObject({
      ok: false,
      code: 'TEST_ADMIN',
      auditId: 71,
    })
    expect(sent).toHaveLength(0)
  })

  it('says so when the model cannot answer, keeping the audit id', async () => {
    as('viewer')
    modelAnswers({}, 503)
    expect((await askAlertHelp(ask)).data).toEqual({
      ok: false,
      code: 'AI_UNAVAILABLE',
      message: ADMIN_ERROR_WORDS.AI_UNAVAILABLE,
      auditId: 70,
    })
  })

  it('refuses before SQL when the copilot is off or asked too often', async () => {
    const session = as('viewer')
    ai.DEEPSEEK_API_KEY = undefined
    expect((await askAlertHelp(ask)).data).toMatchObject({ ok: false, code: 'AI_OFF' })
    ai.DEEPSEEK_API_KEY = 'sk-test'
    vi.mocked(withinLimit).mockResolvedValue(false)
    expect((await askAlertHelp(ask)).data).toMatchObject({ ok: false, code: 'COPILOT_BUSY' })
    expect(session.rpc).not.toHaveBeenCalledWith('admin_alert_help', expect.anything())
  })

  it('validates first: an id, a known mode and a page in words', async () => {
    const session = as('viewer')
    for (const bad of [
      { ...ask, alertId: 'x' },
      { ...ask, mode: 'act' },
      { ...ask, page: '<script>' },
    ]) {
      expect((await askAlertHelp(bad as never)).validationErrors, JSON.stringify(bad)).toBeDefined()
    }
    expect(session.rpc).not.toHaveBeenCalledWith('admin_alert_help', expect.anything())
  })
})

describe('AlertHelp', () => {
  it('offers a ticket only where the supplier may be the cause, each button named for its alert', () => {
    expect(offersTicket('supplier_price_drift')).toBe(true)
    expect(offersTicket('job_needs_attention')).toBe(true)
    expect(offersTicket('email_failed')).toBe(false)
    const { unmount } = render(
      <AlertHelp alertId={1} kind="email_failed" kindLabel="Email failed" page="Emails" />,
    )
    expect(
      screen.getByRole('button', { name: copilotButtonLabel('explain', 'Email failed') }),
    ).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Draft supplier ticket/ })).toBeNull()
    unmount()
  })

  it('asks when opened, shows the answer and the AI note, and lets a failure be asked again', async () => {
    as('viewer')
    modelAnswers({ explanation: 'The price list sync was refused.', steps: ['Open Price list.'] })
    render(
      <AlertHelp
        alertId={42}
        kind="catalogue_sync"
        kindLabel="Price list sync problem"
        page="Price list"
      />,
    )
    await userEvent.click(
      screen.getByRole('button', {
        name: copilotButtonLabel('explain', 'Price list sync problem'),
      }),
    )
    expect(await screen.findByText('The price list sync was refused.')).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveTextContent('Open Price list.')
    expect(screen.getByText(COPILOT.note)).toBeInTheDocument()
  })
})
