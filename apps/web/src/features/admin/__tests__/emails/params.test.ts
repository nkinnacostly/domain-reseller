import { adminHrefForAlertKey } from '@dr/shared/admin'
import { describe, expect, it } from 'vitest'
import {
  chosen,
  emailsHref,
  emailsTabHref,
  isEmailsFiltered,
  type NoticeParams,
  type OutboxParams,
  parseEmailsParams,
  watDayEnd,
  watDayStart,
} from '@/features/admin/lib/emails-params'

/**
 * The emails page's URL (ADMIN-SPEC §5.2 B11, §9's link contract): what
 * other pages link here with opens with that filter, anything unknown falls
 * back to the unfiltered list, and links are rebuilt from parsed values.
 */

const outbox = (search: Record<string, string>) => parseEmailsParams(search) as OutboxParams
const notices = (search: Record<string, string>) => parseEmailsParams(search) as NoticeParams

describe('parseEmailsParams: the link contract', () => {
  it('opens the failed emails for ?status=failed (the overview, §9)', () => {
    const params = outbox({ status: 'failed' })
    expect(params).toMatchObject({ tab: 'outbox', status: 'failed', category: null, kind: null })
    expect(emailsHref(params)).toBe('/admin/emails?status=failed')
  })

  it('accepts every address an alert links to (§4.5)', () => {
    for (const key of [
      'email_failed:0e1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
      'email_unconfirmed:0e1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
      'email_complaint:0e1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
      'emails_waiting:true',
      'notice_bounced:6a6b6c6d-7e7f-4a8b-8c9d-aeafb0b1c2c3',
    ]) {
      const href = adminHrefForAlertKey(key)
      const url = new URL(href, 'https://www.mydomainshub.com')
      expect(url.pathname, key).toBe('/admin/emails')
      const params = parseEmailsParams(url.searchParams)
      // The page opens exactly where the alert pointed: the rebuilt link is the same.
      expect(emailsHref(params), key).toBe(href)
    }
    expect(outbox({ status: 'unconfirmed' }).status).toBe('unconfirmed')
    expect(outbox({ status: 'complained' }).status).toBe('complained')
    expect(outbox({ status: 'pending' }).status).toBe('pending')
    expect(parseEmailsParams({ tab: 'compliance' }).tab).toBe('compliance')
  })

  it('falls back to the unfiltered outbox for anything it does not know', () => {
    expect(
      outbox({ status: 'everything', tab: 'spam', category: 'promo', kind: 'Bad Kind!' }),
    ).toEqual({
      tab: 'outbox',
      status: null,
      category: null,
      kind: null,
      user: null,
      sort: 'created',
      dir: 'desc',
      page: 1,
      per: 25,
      from: null,
      to: null,
    })
    expect(emailsHref(outbox({ status: 'nope' }))).toBe('/admin/emails')
  })

  it('narrows to one account by its id for ?user= (a customer’s Emails tab), never an address', () => {
    const id = '2A2B2C2D-3E3F-4A4B-8C5D-6E6F7A7B8C8D'
    const params = outbox({ user: id, status: 'failed' })
    expect(params.user).toBe(id.toLowerCase())
    expect(emailsHref(params)).toBe(`/admin/emails?status=failed&user=${id.toLowerCase()}`)
    // Another filter keeps the account; clearing it shows every account.
    expect(emailsHref(params, { status: null })).toBe(`/admin/emails?user=${id.toLowerCase()}`)
    expect(emailsHref(params, { user: null })).toBe('/admin/emails?status=failed')
    for (const bad of ['e2e-x@example.com', 'getpaid.com', '1234']) {
      expect(outbox({ user: bad }).user, bad).toBeNull()
    }
    expect(isEmailsFiltered(outbox({ user: id }))).toBe(true)
    // The compliance tab has no account filter.
    expect(emailsHref(parseEmailsParams({ tab: 'compliance', user: id }))).toBe(
      '/admin/emails?tab=compliance',
    )
  })

  it('takes one status: the first known one in a comma list', () => {
    expect(outbox({ status: 'nope,bounced,failed' }).status).toBe('bounced')
    expect(outbox({ status: ['sent', 'failed'] as unknown as string }).status).toBe('sent')
  })

  it('never takes an address: a kind is a stored kind name or nothing', () => {
    expect(outbox({ kind: 'order_receipt' }).kind).toBe('order_receipt')
    expect(outbox({ kind: 'someone@example.com' }).kind).toBeNull()
    expect(outbox({ kind: 'x'.repeat(41) }).kind).toBeNull()
  })

  it('reads the compliance tab with its own filters, sort and dates', () => {
    const params = notices({
      tab: 'compliance',
      status: 'bounced',
      type: 'errp_post',
      sort: 'expires',
      dir: 'asc',
      from: '2026-10-05',
      to: '2026-10-01',
      page: '3',
      per: '50',
    })
    expect(params).toEqual({
      tab: 'compliance',
      status: 'bounced',
      type: 'errp_post',
      sort: 'expires',
      dir: 'asc',
      page: 3,
      per: 50,
      // Dates given the wrong way round are swapped, not dropped.
      from: '2026-10-01',
      to: '2026-10-05',
    })
    expect(emailsHref(params)).toBe(
      '/admin/emails?tab=compliance&status=bounced&type=errp_post&from=2026-10-01&to=2026-10-05&sort=expires&dir=asc&per=50&page=3',
    )
    // An outbox status means nothing on the compliance tab.
    expect(notices({ tab: 'compliance', status: 'failed' }).status).toBeNull()
  })
})

describe('emailsHref', () => {
  it('leaves defaults out, and goes back to page 1 when a filter changes', () => {
    const params = outbox({ status: 'failed', page: '4', category: 'security' })
    expect(emailsHref(params)).toBe('/admin/emails?status=failed&category=security&page=4')
    expect(emailsHref(params, { page: 5 })).toBe(
      '/admin/emails?status=failed&category=security&page=5',
    )
    expect(emailsHref(params, { status: null })).toBe('/admin/emails?category=security')
    expect(emailsHref(params, { sort: 'sent', dir: 'asc' })).toBe(
      '/admin/emails?status=failed&category=security&sort=sent&dir=asc',
    )
    expect(emailsHref(params, { kind: 'refund_sent', from: '2026-10-01' })).toBe(
      '/admin/emails?status=failed&category=security&kind=refund_sent&from=2026-10-01',
    )
  })

  it('drops a date that is not a calendar date', () => {
    const params = outbox({})
    expect(emailsHref(params, { from: '2026-02-30' })).toBe('/admin/emails')
  })

  it('links each tab to its own address', () => {
    expect(emailsTabHref('outbox')).toBe('/admin/emails')
    expect(emailsTabHref('compliance')).toBe('/admin/emails?tab=compliance')
    expect(emailsHref(notices({ tab: 'compliance' }))).toBe('/admin/emails?tab=compliance')
  })
})

describe('chips and filters', () => {
  it('chooses a chip, and choosing it again shows them all', () => {
    expect(chosen(null, 'failed')).toBe('failed')
    expect(chosen('failed', 'sent')).toBe('sent')
    expect(chosen('failed', 'failed')).toBeNull()
  })

  it('knows when a list is narrowed by more than its sort and page', () => {
    expect(isEmailsFiltered(outbox({ sort: 'sent', page: '2' }))).toBe(false)
    expect(isEmailsFiltered(outbox({ status: 'failed' }))).toBe(true)
    expect(isEmailsFiltered(outbox({ category: 'security' }))).toBe(true)
    expect(isEmailsFiltered(outbox({ kind: 'refund_sent' }))).toBe(true)
    expect(isEmailsFiltered(outbox({ to: '2026-10-01' }))).toBe(true)
    expect(isEmailsFiltered(notices({ tab: 'compliance' }))).toBe(false)
    expect(isEmailsFiltered(notices({ tab: 'compliance', type: 'errp_pre_7' }))).toBe(true)
  })
})

describe('Lagos days', () => {
  it('starts a day at midnight WAT and ends it at the next midnight, across a month end', () => {
    expect(watDayStart('2026-10-01')).toBe('2026-10-01T00:00:00+01:00')
    expect(watDayEnd('2026-10-31')).toBe('2026-11-01T00:00:00+01:00')
    expect(watDayEnd('2026-12-31')).toBe('2027-01-01T00:00:00+01:00')
  })
})
