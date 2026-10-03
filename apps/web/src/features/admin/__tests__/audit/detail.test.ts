import { describe, expect, it } from 'vitest'
import { HIDDEN_VALUE } from '@/features/admin/lib/audit-copy'
import { detailLines, isPrivateKey, maskEmailsIn } from '@/features/admin/lib/audit-detail'

const line = (label: string, value: string, hidden = false) => ({ label, value, hidden })

describe('detailLines', () => {
  it('shows nothing for an empty detail, or one that is not an object', () => {
    expect(detailLines({})).toEqual([])
    expect(detailLines(null)).toEqual([])
    expect(detailLines('text')).toEqual([])
    expect(detailLines([1, 2])).toEqual([])
  })

  it('reads a refund approval as the wrapper records it, money as money', () => {
    expect(
      detailLines({
        before: { status: 'held', amount_kobo: 1_250_000, last_error_code: null },
        limits: { single_kobo: 10_000_000, daily_kobo: 50_000_000 },
        after: { status: 'queued', approved_by: 'owner' },
      }),
    ).toEqual([
      line('before.status', 'held'),
      line('before.amount_kobo', '₦12,500'),
      line('before.last_error_code', '—'),
      line('limits.single_kobo', '₦100,000'),
      line('limits.daily_kobo', '₦500,000'),
      line('after.status', 'queued'),
      line('after.approved_by', 'owner'),
    ])
  })

  it('reads a customer search: what kind, and the accounts matched by id — never the query', () => {
    expect(
      detailLines({ kind: 'email', matched: ['2a2b2c2d-3e3f-4a4b-8c5d-6e6f7a7b8c8d'] }),
    ).toEqual([line('kind', 'email'), line('matched', '2a2b2c2d-3e3f-4a4b-8c5d-6e6f7a7b8c8d')])
    expect(detailLines({ kind: 'domain', matched: [] })).toEqual([
      line('kind', 'domain'),
      line('matched', 'none'),
    ])
  })

  it('reads cents as dollars, times in Lagos time, and yes or no', () => {
    expect(
      detailLines({
        supplierCents: 1131,
        usd_cents: -250,
        checked_at: '2026-10-03T11:05:00+00:00',
        cached: true,
        found: false,
        rate_kobo_per_cent: 1328.1,
        move_pct: 2.5,
      }),
    ).toEqual([
      line('supplierCents', '$11.31'),
      line('usd_cents', '−$2.50'),
      line('checked_at', '3 Oct 2026, 12:05 WAT'),
      line('cached', 'yes'),
      line('found', 'no'),
      line('rate_kobo_per_cent', '1328.1'),
      line('move_pct', '2.5'),
    ])
  })

  it('lists a preset’s nameservers on one line', () => {
    expect(
      detailLines({
        provider: 'Vercel',
        before: { nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] },
      }),
    ).toEqual([
      line('provider', 'Vercel'),
      line('before.nameservers', 'ns1.vercel-dns.com, ns2.vercel-dns.com'),
    ])
  })

  it('never shows a value whose key names personal data or a secret, at any depth', () => {
    const lines = detailLines({
      email: 'ada@example.com',
      fullName: 'Ada Obi',
      contact: { email: 'ada@example.com', phone: '+2348012345678' },
      after: { registrant: { name: 'Ada Obi' }, status: 'ok' },
      rows: [{ maskedEmail: 'a•••@example.com', phone: '0801' }],
      private_key: '-----BEGIN',
    })
    expect(lines).toEqual([
      line('email', HIDDEN_VALUE, true),
      line('fullName', HIDDEN_VALUE, true),
      line('contact', HIDDEN_VALUE, true),
      line('after.registrant', HIDDEN_VALUE, true),
      line('after.status', 'ok'),
      line('rows[0].maskedEmail', 'a•••@example.com'),
      line('rows[0].phone', HIDDEN_VALUE, true),
      line('private_key', HIDDEN_VALUE, true),
    ])
    const text = JSON.stringify(lines)
    for (const secret of ['ada@example.com', 'Ada Obi', '2348012345678', 'BEGIN']) {
      expect(text).not.toContain(secret)
    }
  })

  it('masks an email wherever it sits in a value, a list or a key', () => {
    expect(
      detailLines({
        note: 'sent to ada@example.com and bo@test.ng',
        list: ['x@y.com', 'plain'],
        'who@where.com': 'value',
      }),
    ).toEqual([
      line('note', 'sent to a•••@example.com and b•••@test.ng'),
      line('list', 'x•••@y.com, plain'),
      line('w•••@where.com', 'value'),
    ])
  })

  it('cuts a long text and stops at a depth', () => {
    const [long] = detailLines({ text: 'z'.repeat(500) })
    expect(long?.value).toHaveLength(200)
    expect(long?.value.endsWith('…')).toBe(true)
    expect(detailLines({ a: { b: { c: { d: { e: 1 } } } } })).toEqual([line('a.b.c.d', '{…}')])
    expect(detailLines({ a: { b: { c: { d: [{ e: 1 }] } } } })).toEqual([line('a.b.c.d', '[…]')])
    expect(detailLines({ list: [[1, 2], { x: 1 }] })).toEqual([
      line('list[0]', '1, 2'),
      line('list[1].x', '1'),
    ])
    expect(detailLines({ empty: {} })).toEqual([line('empty', 'none')])
  })

  it('shows at most forty lines, and says how many more there were', () => {
    const many = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${i}`, i]))
    const lines = detailLines(many)
    expect(lines).toHaveLength(41)
    expect(lines.at(-1)).toEqual(line('…', '5 more not shown'))
  })

  it('keeps every line’s label its own, even when a cut path repeats', () => {
    const key = 'k'.repeat(250)
    const lines = detailLines({ [`${key}a`]: 1, [`${key}b`]: 2 })
    expect(lines.map((one) => one.label)).toEqual([
      `${'k'.repeat(199)}…`,
      `${'k'.repeat(199)}… (2)`,
    ])
  })

  it('shows other values as text', () => {
    expect(detailLines({ big: 1.5e300, undef: undefined })).toEqual([
      line('big', '1.5e+300'),
      line('undef', '—'),
    ])
  })
})

describe('isPrivateKey and maskEmailsIn', () => {
  it('knows a private key in any spelling', () => {
    for (const key of ['email', 'Email', 'to_email', 'fullName', 'full_name', 'AUTH_CODE', 'key']) {
      expect(isPrivateKey(key), key).toBe(true)
    }
    for (const key of ['status', 'request_key', 'kind', 'provider', 'code', 'amount_kobo']) {
      expect(isPrivateKey(key), key).toBe(false)
    }
  })

  it('masks as SQL’s admin_mask_email does, and leaves a masked address as it is', () => {
    expect(maskEmailsIn('ada@example.com')).toBe('a•••@example.com')
    expect(maskEmailsIn('a•••@example.com')).toBe('a•••@example.com')
    expect(maskEmailsIn('no address here')).toBe('no address here')
    expect(maskEmailsIn('(ada@example.com), bo@x.org')).toBe('(a•••@example.com), b•••@x.org')
  })
})
