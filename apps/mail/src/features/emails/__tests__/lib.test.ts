import { decodeCursor } from '@dr/shared/mail'
import { describe, expect, it } from 'vitest'
import { bounceWords } from '../lib/bounce'
import { lagosDayEnd, lagosDayStart, lagosTime, lagosTimeWithSeconds } from '../lib/format'
import { readSearch, searchHref } from '../lib/search'
import { bodyKeptUntil, timeline } from '../lib/timeline'
import { EVENT_WORDS, isScheduled, reasonWords } from '../lib/words'
import type { EmailDetail, EmailEvent } from '../queries/log'

const ID = '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d'

describe('Lagos time, written out the same everywhere', () => {
  it('is UTC+1, with no daylight saving, in words that never depend on the browser', () => {
    expect(lagosTime('2026-10-06T09:42:07Z')).toBe('6 Oct 2026, 10:42')
    expect(lagosTime('2026-12-31T23:30:00Z')).toBe('1 Jan 2027, 00:30')
    expect(lagosTimeWithSeconds('2026-06-01T00:00:05.123456Z')).toBe('1 Jun 2026, 01:00:05')
  })

  it('turns a Lagos day into the moments that bound it', () => {
    expect(lagosDayStart('2026-10-06')).toBe('2026-10-06T00:00:00+01:00')
    expect(lagosDayEnd('2026-10-06')).toBe('2026-10-07T00:00:00+01:00')
    expect(lagosDayEnd('2026-12-31')).toBe('2027-01-01T00:00:00+01:00')
  })
})

describe('the log’s search', () => {
  it('reads every field, lower-cases what SQL compares exactly, and bounds the days in Lagos', () => {
    const search = readSearch({
      id: ID.toUpperCase(),
      to: 'Ada@Example.com',
      subject: 'receipt',
      tag: 'kind:receipt',
      status: 'bounced',
      since: '2026-10-01',
      until: '2026-10-06',
    })
    expect(search.errors).toEqual({})
    expect(search.isFiltered).toBe(true)
    expect(search.filters).toEqual({
      id: ID,
      to: 'ada@example.com',
      subject: 'receipt',
      tag: 'kind:receipt',
      status: 'bounced',
      createdAfter: '2026-10-01T00:00:00+01:00',
      createdBefore: '2026-10-07T00:00:00+01:00',
    })
  })

  it('names each field that is not valid, and searches with none of them', () => {
    const search = readSearch({
      id: '42',
      to: 'nobody',
      subject: 'x'.repeat(201),
      tag: 'a b',
      status: 'lost',
      since: 'yesterday',
      until: '2026-02-30',
    })
    expect(Object.keys(search.errors).sort()).toEqual(
      ['id', 'since', 'status', 'subject', 'tag', 'to', 'until'].sort(),
    )
    expect(search.filters).toEqual({})
    expect(readSearch({ since: '2026-10-06', until: '2026-10-01' }).errors.until).toContain(
      'on or after',
    )
  })

  it('takes the first of a repeated field, and an empty search is no search', () => {
    expect(readSearch({ status: ['sent', 'queued'] }).filters.status).toBe('sent')
    const empty = readSearch({})
    expect(empty.isFiltered).toBe(false)
    expect(empty.cursor).toBeNull()
  })

  it('keeps the search across pages, and reads the cursor back', () => {
    const values = readSearch({ status: 'sent', to: 'ada@example.com' }).values
    expect(searchHref(values)).toBe('/dashboard/emails?to=ada%40example.com&status=sent')
    const href = searchHref(values, { at: '2026-10-06T09:30:00.123456Z', id: ID })
    const cursor = new URL(href, 'http://x').searchParams.get('cursor') ?? ''
    expect(decodeCursor(cursor)).toEqual({ at: '2026-10-06T09:30:00.123456Z', id: ID })
    expect(readSearch({ cursor }).cursor?.id).toBe(ID)
    expect(readSearch({ cursor: 'junk!' }).cursor).toBeNull()
    expect(searchHref(readSearch({}).values)).toBe('/dashboard/emails')
  })
})

describe('words', () => {
  it('gives every SES event a label and a sentence', () => {
    for (const words of Object.values(EVENT_WORDS)) {
      expect(words.label.length).toBeGreaterThan(2)
      expect(words.detail).toMatch(/\.$/)
    }
  })

  it('says why an email was not sent, and shows a code it has no words for', () => {
    expect(reasonWords(null)).toBeNull()
    expect(reasonWords('key_revoked')).toContain('revoked')
    expect(reasonWords('worker_lost')).toContain('may or may not')
    expect(reasonWords('throttling_weird')).toBe('It was not sent (code: throttling_weird).')
  })

  it('calls an email scheduled only while it waits for a later moment', () => {
    const at = '2026-10-06T09:00:00Z'
    expect(
      isScheduled({ status: 'queued', created_at: at, scheduled_at: '2026-10-06T10:00:00Z' }),
    ).toBe(true)
    expect(isScheduled({ status: 'queued', created_at: at, scheduled_at: at })).toBe(false)
    expect(
      isScheduled({ status: 'sent', created_at: at, scheduled_at: '2026-10-06T10:00:00Z' }),
    ).toBe(false)
  })
})

describe('a bounce in plain words', () => {
  it('reads SES’s type and subtype, and what the server said', () => {
    const full = bounceWords({
      bounceType: 'Permanent',
      bounceSubType: 'NoEmail',
      diagnosticCode: 'smtp; 550 5.1.1 [address]: no such user',
    })
    expect(full.summary).toBe('This address does not exist. Sending to it again will bounce again.')
    expect(full.serverSaid).toContain('550 5.1.1')
    expect(full.kind).toBe('Permanent / NoEmail')
    expect(
      bounceWords({ bounceType: 'Transient', bounceSubType: 'MailboxFull' }).summary,
    ).toContain('mailbox is full')
  })

  it('falls back to the type alone, then to plain words', () => {
    expect(bounceWords({ bounceType: 'Transient', bounceSubType: 'Odd' }).summary).toContain(
      'for now',
    )
    expect(bounceWords({ bounceType: 'Undetermined' }).kind).toBe('Undetermined')
    const nothing = bounceWords({})
    expect(nothing).toEqual({
      summary: 'The receiving server turned it away.',
      serverSaid: null,
      kind: null,
    })
    expect(bounceWords({ smtpResponse: ' 554 refused ' }).serverSaid).toBe('554 refused')
  })
})

const email = (over: Partial<EmailDetail> = {}): EmailDetail => ({
  id: 7,
  public_id: ID,
  from_address: 'Acme <hello@acme.example>',
  to_addresses: ['ada@example.com'],
  cc_addresses: [],
  bcc_addresses: [],
  reply_to: [],
  recipient_count: 1,
  subject: 'Your receipt',
  tags: [],
  status: 'delivered',
  status_reason: null,
  ses_message_id: 'ses-1',
  created_at: '2026-10-06T09:00:00Z',
  scheduled_at: '2026-10-06T09:00:00Z',
  sent_at: '2026-10-06T09:00:02Z',
  delivered_at: '2026-10-06T09:00:04Z',
  bounced_at: null,
  complained_at: null,
  failed_at: null,
  canceled_at: null,
  ...over,
})

const event = (id: number, type: EmailEvent['type'], at: string, detail = {}): EmailEvent => ({
  id,
  type,
  occurred_at: at,
  detail,
})

describe('the timeline', () => {
  it('runs from queued through each event, oldest first, a bounce with its words', () => {
    const items = timeline(email({ status: 'bounced' }), [
      event(2, 'bounce', '2026-10-06T09:00:06Z', { bounceType: 'Permanent' }),
      event(1, 'send', '2026-10-06T09:00:02Z'),
    ])
    expect(items.map((item) => item.label)).toEqual(['Queued', 'Sent', 'Bounced'])
    expect(items[2]?.bounce?.summary).toContain('for good')
    expect(items[2]?.tone).toBe('danger')
  })

  it('shows when a scheduled email was due, and when it was canceled', () => {
    const items = timeline(
      email({
        status: 'canceled',
        status_reason: 'canceled',
        scheduled_at: '2026-10-06T12:00:00Z',
        canceled_at: '2026-10-06T10:00:00Z',
        sent_at: null,
        delivered_at: null,
      }),
      [],
    )
    expect(items.map((item) => item.label)).toEqual(['Queued', 'Canceled', 'Due'])
  })

  it('dates a failure of ours, but leaves SES’s own to its event', () => {
    const ours = timeline(
      email({ status: 'failed', status_reason: 'key_revoked', failed_at: '2026-10-06T09:01:00Z' }),
      [],
    )
    expect(ours.at(-1)).toMatchObject({
      label: 'Not sent',
      detail: expect.stringContaining('revoked'),
    })
    const ses = timeline(
      email({ status: 'failed', status_reason: 'reject', failed_at: '2026-10-06T09:01:00Z' }),
      [event(1, 'reject', '2026-10-06T09:01:00Z')],
    )
    expect(ses.map((item) => item.label)).toEqual(['Queued', 'Rejected'])
  })

  it('keeps a body 72 hours after it left the queue, and says nothing while it waits', () => {
    expect(bodyKeptUntil(email())).toBe('2026-10-09T09:00:02.000Z')
    expect(bodyKeptUntil(email({ sent_at: null, canceled_at: '2026-10-06T10:00:00Z' }))).toBe(
      '2026-10-09T10:00:00.000Z',
    )
    expect(bodyKeptUntil(email({ status: 'queued', sent_at: null }))).toBeNull()
  })
})
