import { describe, expect, it } from 'vitest'
import {
  apiKeySchema,
  createApiKeySchema,
  createdApiKeySchema,
  decodeCursor,
  emailListSchema,
  emailRowSchema,
  emailSchema,
  encodeCursor,
  listEmailsQuerySchema,
  readQuery,
  rescheduleSchema,
  toSqlFilters,
} from './resources'

const ID = '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d'

describe('the log’s query (GET /emails)', () => {
  it('reads every filter, lower-cases the recipient, and coerces the limit', () => {
    const parsed = listEmailsQuerySchema.parse({
      limit: '50',
      status: 'bounced',
      to: 'Ada@Example.COM',
      tag: 'kind:receipt',
      subject: '  receipt ',
      created_after: '2026-10-01T00:00:00+01:00',
      created_before: '2026-10-08T00:00:00Z',
    })
    expect(parsed).toMatchObject({
      limit: 50,
      to: 'ada@example.com',
      subject: 'receipt',
      tag: 'kind:receipt',
    })
    expect(listEmailsQuerySchema.parse({})).toEqual({})
  })

  it('refuses what it cannot act on (N9b): unknown filters, bad limits, statuses, dates', () => {
    for (const bad of [
      { from: 'a@b.example' },
      { limit: '0' },
      { limit: '101' },
      { limit: '2.5' },
      { status: 'lost' },
      { to: 'nobody' },
      { tag: 'a b' },
      { tag: 'a:b:c' },
      { created_after: '2026-10-01' },
      { subject: '' },
    ]) {
      expect(listEmailsQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('takes each parameter once', () => {
    expect(
      readQuery([
        ['status', 'sent'],
        ['limit', '5'],
      ]),
    ).toEqual({ ok: true, query: { status: 'sent', limit: '5' } })
    expect(
      readQuery([
        ['status', 'sent'],
        ['status', 'queued'],
      ]),
    ).toEqual({ ok: false, repeated: 'status' })
    // A parameter named like the answer's own key is still just a parameter.
    expect(readQuery([['repeated', '1']])).toEqual({ ok: true, query: { repeated: '1' } })
  })

  it('hands SQL its filter names, the tag split and times in UTC', () => {
    expect(
      toSqlFilters({
        id: ID,
        status: 'sent',
        to: 'ADA@example.com',
        tag: 'kind:receipt',
        subject: 'receipt',
        createdAfter: '2026-10-01T00:00:00+01:00',
        createdBefore: '2026-10-08T00:00:00Z',
      }),
    ).toEqual({
      id: ID,
      status: 'sent',
      to: 'ada@example.com',
      tag_name: 'kind',
      tag_value: 'receipt',
      subject: 'receipt',
      created_after: '2026-09-30T23:00:00.000Z',
      created_before: '2026-10-08T00:00:00.000Z',
    })
    expect(toSqlFilters({ tag: 'kind' })).toEqual({ tag_name: 'kind' })
    expect(toSqlFilters({})).toEqual({})
  })
})

describe('cursors', () => {
  it('round-trip PostgreSQL’s moment to the microsecond, opaque and URL-safe', () => {
    const cursor = { at: '2026-10-06T09:30:00.123456Z', id: ID }
    const text = encodeCursor(cursor)
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(text)).toEqual(cursor)
    expect(decodeCursor(encodeCursor({ at: '2026-10-06 09:30:00+00', id: ID }))).toEqual({
      at: '2026-10-06 09:30:00+00',
      id: ID,
    })
  })

  it('refuses anything this API did not make', () => {
    expect(decodeCursor('not a cursor!')).toBeNull()
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('abcde')).toBeNull()
    expect(decodeCursor(encodeCursor({ at: 'yesterday', id: ID }))).toBeNull()
    expect(decodeCursor(encodeCursor({ at: '2026-10-06T09:30:00Z', id: '42' }))).toBeNull()
    expect(decodeCursor(encodeCursor({ at: `2026-10-06T09:30:00Z|${ID}`, id: ID }))).toBeNull()
  })
})

describe('the other inputs', () => {
  it('a reschedule is one moment with its zone', () => {
    expect(rescheduleSchema.safeParse({ scheduled_at: '2026-10-07T09:00:00Z' }).success).toBe(true)
    expect(rescheduleSchema.safeParse({ scheduled_at: '2026-10-07 09:00' }).success).toBe(false)
    expect(rescheduleSchema.safeParse({}).success).toBe(false)
    expect(
      rescheduleSchema.safeParse({ scheduled_at: '2026-10-07T09:00:00Z', extra: 1 }).success,
    ).toBe(false)
  })

  it('a new key has a name and a permission; only a sending key takes a domain', () => {
    expect(createApiKeySchema.parse({ name: '  Billing ', permission: 'sending' })).toEqual({
      name: 'Billing',
      permission: 'sending',
    })
    expect(
      createApiKeySchema.safeParse({ name: 'x', permission: 'sending', domain_id: ID }).success,
    ).toBe(true)
    const full = createApiKeySchema.safeParse({ name: 'x', permission: 'full', domain_id: ID })
    expect(full.success).toBe(false)
    if (!full.success) expect(full.error.issues[0]?.path).toEqual(['domain_id'])
    expect(createApiKeySchema.safeParse({ name: 'x' }).success).toBe(false)
    expect(createApiKeySchema.safeParse({ name: ' ', permission: 'full' }).success).toBe(false)
    expect(createApiKeySchema.safeParse({ name: 'x', permission: 'admin' }).success).toBe(false)
  })
})

describe('the answers', () => {
  const row = {
    id: ID,
    from: 'a@b.example',
    to: ['c@d.example'],
    cc: [],
    bcc: [],
    reply_to: [],
    subject: 'Hi',
    tags: [],
    status: 'queued',
    status_reason: null,
    created_at: '2026-10-06T09:30:00.000000Z',
    scheduled_at: '2026-10-06T10:30:00.000000Z',
    sent_at: null,
    delivered_at: null,
    bounced_at: null,
    complained_at: null,
    failed_at: null,
    canceled_at: null,
    last_event: null,
    last_event_at: null,
  }

  it('an email is SQL’s row with `object`, never a body', () => {
    expect(emailRowSchema.parse(row)).toEqual(row)
    expect(emailSchema.parse({ object: 'email', ...row })).toMatchObject({ id: ID })
    expect(
      emailListSchema.safeParse({ object: 'list', data: [], has_more: false, next_cursor: null })
        .success,
    ).toBe(true)
    expect(emailRowSchema.safeParse({ ...row, last_event: 'open' }).success).toBe(false)
  })

  it('a key never carries its secret, except the once it is made', () => {
    const key = {
      object: 'api_key',
      id: ID,
      name: 'Billing',
      prefix: 'mdh_live_ab12',
      permission: 'sending',
      domain_id: null,
      created_at: '2026-10-06T09:30:00.000000Z',
      last_used_at: null,
    }
    expect(Object.keys(apiKeySchema.parse({ ...key, key: 'mdh_live_x' }))).not.toContain('key')
    expect(createdApiKeySchema.parse({ ...key, key: 'mdh_live_x' }).key).toBe('mdh_live_x')
  })
})
