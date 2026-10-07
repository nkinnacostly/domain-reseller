import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { ACCOUNT, fakeSupabase } from '../../accounts/__tests__/fake-supabase'
import {
  canManageWebhooks,
  describeAnswer,
  describeReason,
  EVENT_GROUPS,
  WEBHOOK_FALLBACK,
  webhookRefusal,
} from '../lib/words'
import { getDeliveries, getWebhooks, readDeliveries, readWebhooks } from '../queries/webhooks'

/** The Webhooks page's words and reads (MAIL-SPEC §6, §10). */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const WEBHOOK_ROW = {
  id: '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f',
  url: 'https://hooks.acme.example/mail',
  description: null,
  events: ['email.delivered', 'email.opened'],
  secret_hint: 'whsec_ab12',
  status: 'disabled',
  disabled_reason: 'failing',
  disabled_at: '2026-10-06T08:00:00Z',
  failing_since: '2026-10-03T08:00:00Z',
  last_success_at: null,
  created_at: '2026-10-01T08:00:00Z',
}

const DELIVERY_ROW = {
  id: 41,
  webhook_id: WEBHOOK_ROW.id,
  message_id: `msg_${'a'.repeat(32)}`,
  event_type: 'email.bounced',
  payload: { type: 'email.bounced' },
  status: 'failed',
  status_reason: 'gave_up',
  attempts: 9,
  next_attempt_at: '2026-10-06T08:00:00Z',
  last_attempt_at: '2026-10-06T08:00:00Z',
  last_status_code: 503,
  last_error: 'http_status',
  last_response: 'down',
  last_duration_ms: 80,
  history: [{ at: '2026-10-06T08:00:00Z', status: 503, error: 'http_status', ms: 80 }, { nope: 1 }],
  resend_of: null,
  created_at: '2026-10-05T08:00:00Z',
}

beforeEach(() => vi.clearAllMocks())

describe('words', () => {
  it('describes an answer by its status, or by why there was none', () => {
    const base = { lastStatusCode: null, lastError: null, lastDurationMs: null, attempts: 1 }
    expect(describeAnswer({ ...base, attempts: 0 })).toBe('Not tried yet')
    expect(describeAnswer({ ...base, lastStatusCode: 200, lastDurationMs: 120 })).toBe(
      'HTTP 200 in 120 ms',
    )
    expect(describeAnswer({ ...base, lastStatusCode: 500 })).toBe('HTTP 500')
    expect(describeAnswer({ ...base, lastError: 'timeout' })).toBe('No answer within 10 seconds')
    expect(describeAnswer({ ...base, lastError: 'private_address' })).toMatch(/private address/)
    expect(describeAnswer({ ...base, lastError: 'port_not_allowed' })).toMatch(/443 or 8443/)
    expect(describeAnswer({ ...base, lastError: 'something new' })).toBe('No answer')
    expect(describeReason('gave_up')).toMatch(/24 hours/)
    expect(describeReason('endpoint_disabled')).toMatch(/turned off/)
    expect(describeReason('other')).toBeNull()
    expect(describeReason(null)).toBeNull()
  })

  it('words SQL’s refusals, a field’s, the limit, and anything else as the fallback', () => {
    expect(webhookRefusal({ code: 'validation', field: 'events' })).toBe(
      'Choose at least one event.',
    )
    expect(webhookRefusal({ code: 'validation', field: 'nope' })).toBe(WEBHOOK_FALLBACK)
    expect(webhookRefusal({ code: 'webhook_limit', max: 10 })).toMatch(/10 endpoints/)
    expect(webhookRefusal({ code: 'webhook_limit' })).toMatch(/the most endpoints/)
    expect(webhookRefusal({ code: 'webhook_disabled' })).toMatch(/turned off/)
    expect(webhookRefusal({})).toBe(WEBHOOK_FALLBACK)
  })

  it('groups the eight events, and lets everyone but viewers manage endpoints', () => {
    expect(EVENT_GROUPS.flatMap((g) => g.events)).toHaveLength(8)
    expect(canManageWebhooks('developer')).toBe(true)
    expect(canManageWebhooks('viewer')).toBe(false)
  })
})

describe('reads', () => {
  it('reads endpoints, keeping only events we know', () => {
    expect(readWebhooks([WEBHOOK_ROW, { id: 4 }])).toEqual([
      {
        id: WEBHOOK_ROW.id,
        url: WEBHOOK_ROW.url,
        description: null,
        events: ['email.delivered'],
        secretHint: 'whsec_ab12',
        status: 'disabled',
        disabledReason: 'failing',
        disabledAt: WEBHOOK_ROW.disabled_at,
        failingSince: WEBHOOK_ROW.failing_since,
        lastSuccessAt: null,
        createdAt: WEBHOOK_ROW.created_at,
      },
    ])
    expect(readWebhooks({ not: 'rows' })).toEqual([])
    expect(
      readWebhooks([
        { ...WEBHOOK_ROW, status: 'enabled', disabled_reason: null, events: null, secret_hint: 1 },
      ])[0],
    ).toMatchObject({ status: 'enabled', disabledReason: null, events: [], secretHint: 'whsec_' })
  })

  it('reads deliveries and their attempts, dropping what is not one', () => {
    const [delivery] = readDeliveries([
      DELIVERY_ROW,
      { ...DELIVERY_ROW, status: 'odd' },
      { id: 'x' },
    ])
    expect(delivery).toMatchObject({
      id: 41,
      eventType: 'email.bounced',
      status: 'failed',
      statusReason: 'gave_up',
      attempts: 9,
      lastStatusCode: 503,
      history: [{ at: '2026-10-06T08:00:00Z', status: 503, error: 'http_status', ms: 80 }],
    })
    expect(readDeliveries(null)).toEqual([])
    expect(
      readDeliveries([{ ...DELIVERY_ROW, history: null, attempts: null, payload: undefined }])[0],
    ).toMatchObject({ history: [], attempts: 0, payload: null })
  })

  it('asks for the account’s endpoints and its newest deliveries, by endpoint when asked', async () => {
    const fake = fakeSupabase({
      tables: {
        webhooks: { rows: { data: [WEBHOOK_ROW], error: null } },
        webhook_deliveries: { rows: { data: [DELIVERY_ROW], error: null } },
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getWebhooks(ACCOUNT)).toHaveLength(1)
    expect(await getDeliveries(ACCOUNT, WEBHOOK_ROW.id)).toHaveLength(1)
    expect(fake.calls).toContainEqual({
      table: 'webhook_deliveries',
      method: 'eq',
      args: ['webhook_id', WEBHOOK_ROW.id],
    })
    expect(fake.calls).toContainEqual({ table: 'webhook_deliveries', method: 'limit', args: [50] })
  })

  it('is null when a read fails, so the page shows its error state', async () => {
    const fake = fakeSupabase({
      tables: {
        webhooks: { rows: { data: null, error: { code: '42501' } } },
        webhook_deliveries: { rows: { data: null, error: { code: '42501' } } },
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getWebhooks(ACCOUNT)).toBeNull()
    expect(await getDeliveries(ACCOUNT)).toBeNull()
  })
})
