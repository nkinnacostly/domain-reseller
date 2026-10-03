import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_ACTION_IDS,
  ADMIN_ACTIONS,
  ADMIN_TIERS,
  canAct,
  isMoneyAction,
  rank,
} from '@/features/admin/lib/actions'
import {
  ADMIN_ERROR_WORDS,
  AdminRefusal,
  adminAccessError,
  adminErrorWords,
  adminOutcome,
  FALLBACK_WORDS,
  NEEDS_CODE_WORDS,
  refusedResult,
  SERVER_CRASH_WORDS,
  toAdminResult,
  UNKNOWN_OUTCOME,
  UNRECOGNISED_ADMIN_ERROR,
  WRONG_CODE_WORDS,
} from '@/features/admin/lib/errors'
import {
  ago,
  formatCount,
  formatUsd,
  formatWat,
  formatWatDate,
  formatWatTime,
  maskEmail,
  maskPhone,
  shortId,
} from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import {
  JOB_KIND_LABEL,
  labelFor,
  REFUND_STATUS_LABEL,
  ROLE_LABEL,
} from '@/features/admin/lib/labels'
import {
  ariaSort,
  type ListSpec,
  listHref,
  nextSort,
  pageCount,
  pageRange,
  parseListParams,
  validDate,
} from '@/features/admin/lib/list-params'
import { NO_PLAYBOOK, PLAYBOOK, playbookFor } from '@/features/admin/lib/playbook'
import {
  parseSide,
  SIDE_COOKIE_OPTIONS,
  sideBanner,
  sideFor,
  TEST_ADMIN_BANNER,
  TEST_SIDE_BANNER,
} from '@/features/admin/lib/side'
import { TONE_CLASS, toneOf } from '@/features/admin/lib/tone'

const ROOT = join(__dirname, '../../../../../../..')
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const ADMIN_SQL = readFileSync(join(MIGRATIONS, '00000000000040_admin.sql'), 'utf8')
const DATA_SQL = readFileSync(join(MIGRATIONS, '00000000000041_admin_data.sql'), 'utf8')

describe('ADMIN_ACTIONS mirrors admin_tier (migration 40)', () => {
  const rows = [
    ...ADMIN_SQL.matchAll(
      /\('([a-z_.]+)',\s+'(owner|operator|viewer)',\s*(true|false),\s*'(\w+)'\)/g,
    ),
  ].map(([, action, minRole, money, testRule]) => ({
    action,
    minRole,
    money: money === 'true',
    testRule,
  }))

  it('has every action SQL knows, with the same tier', () => {
    expect(rows.length).toBeGreaterThan(40)
    for (const row of rows) {
      expect(ADMIN_TIERS[row.action as keyof typeof ADMIN_TIERS], row.action).toEqual({
        minRole: row.minRole,
        money: row.money,
        testRule: row.testRule,
      })
    }
  })

  it('has no action SQL does not know, except the side switch, which is not audited', () => {
    const known = new Set(rows.map((row) => row.action))
    expect(ADMIN_ACTION_IDS.filter((id) => !known.has(id))).toEqual(['side.switch'])
    expect(ADMIN_ACTIONS['side.switch']).toEqual({
      minRole: 'viewer',
      money: false,
      testRule: 'test_target',
    })
  })

  it('names in every action file only actions it knows', () => {
    const dir = join(__dirname, '../../actions')
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8')
      for (const [, id] of text.matchAll(/admin(?:Money)?Action\(\s*'([^']+)'/g)) {
        expect(ADMIN_ACTION_IDS as readonly string[], `${file}: ${id}`).toContain(id)
      }
    }
  })

  it('ranks roles, and lets a role do only what its tier allows', () => {
    expect(rank('owner')).toBeGreaterThan(rank('operator'))
    expect(rank('operator')).toBeGreaterThan(rank('viewer'))
    expect(canAct({ role: 'operator', testOnly: false }, 'refund.approve')).toBe(true)
    expect(canAct({ role: 'operator', testOnly: false }, 'refund.cancel')).toBe(false)
    expect(canAct({ role: 'viewer', testOnly: false }, 'supplier.balance')).toBe(true)
    expect(canAct({ role: 'owner', testOnly: true }, 'fx.activate')).toBe(false)
    expect(canAct({ role: 'operator', testOnly: true }, 'refund.approve')).toBe(true)
    expect(isMoneyAction('job.retry')).toBe(true)
    expect(isMoneyAction('email.requeue')).toBe(false)
  })
})

describe('errors: every code has words (§2.4)', () => {
  const sql = `${ADMIN_SQL}\n${DATA_SQL}`
  const raised = new Set(
    [...sql.matchAll(/message = 'admin:([a-z_]+)'/g)].map(([, code]) => code as string),
  )
  const returned = new Set(
    [
      ...sql.matchAll(/'(?:code)',\s*'([A-Z_]+)'/g),
      ...sql.matchAll(/v_code\s*:=\s*'([A-Z_]+)'/g),
      ...sql.matchAll(/'refused',\s*'([A-Z_]+)'/g),
      ...sql.matchAll(/return '([A-Z_]+)'/g),
    ].map(([, code]) => code as string),
  )

  it('words every admin:* code the gate raises', () => {
    expect(raised.size).toBeGreaterThan(5)
    for (const code of raised) expect(ADMIN_ERROR_WORDS[code], code).toBeDefined()
  })

  it('words every code a wrapper or the claim returns', () => {
    expect(returned.size).toBeGreaterThan(30)
    for (const code of returned) {
      expect(ADMIN_ERROR_WORDS[code] ?? ADMIN_ERROR_WORDS[code.toLowerCase()], code).toBeDefined()
    }
  })

  it('uses the words the spec gives', () => {
    expect(adminErrorWords('admin:needs_code')).toBe(NEEDS_CODE_WORDS)
    expect(adminErrorWords('NEEDS_CODE')).toBe(
      "Confirm it's you with the code from your authenticator app to continue.",
    )
    expect(adminErrorWords('ROLE')).toBe("Your admin role can't do this. Ask the owner.")
    expect(adminErrorWords('WRONG_CODE')).toBe(WRONG_CODE_WORDS)
    expect(adminErrorWords('HELD')).toMatch(/paused for 24 hours after a password reset/)
    expect(adminErrorWords('not_admin')).toBe('This needs an administrator.')
    expect(adminErrorWords('RATE_LIMITED')).toBe(
      "You've looked up a lot of customers this hour. Wait, or ask the owner.",
    )
    expect(adminErrorWords('something new')).toBe(FALLBACK_WORDS)
    expect(adminErrorWords(null)).toBe(FALLBACK_WORDS)
  })

  it('never passes a database message through, and calls an unknown error an unknown outcome', () => {
    // A timeout or a lost answer may come after the wrapper committed: not a
    // refusal, so the words never say "nothing changed" and the key is kept.
    for (const raw of [
      'duplicate key value violates unique constraint "admins_pkey"',
      'canceling statement due to statement timeout',
      'TypeError: fetch failed',
      'constructor',
      undefined,
    ]) {
      const error = adminAccessError(raw)
      expect(error, String(raw)).not.toBeInstanceOf(AdminRefusal)
      expect(error.message).toBe(UNRECOGNISED_ADMIN_ERROR)
      expect(error.message).not.toContain('admins_pkey')
    }
    expect(adminOutcome({ serverError: SERVER_CRASH_WORDS })).toMatchObject({
      ok: false,
      code: UNKNOWN_OUTCOME,
    })
    expect(adminAccessError('admin:needs_code')).toMatchObject({
      adminCode: 'needs_code',
      code: 'MFA_REQUIRED',
      message: NEEDS_CODE_WORDS,
    })
    expect(adminAccessError('TEST_ADMIN')).toMatchObject({
      adminCode: 'TEST_ADMIN',
      code: 'FORBIDDEN',
    })
  })

  it("turns a wrapper's JSON into the result contract", () => {
    expect(
      toAdminResult({ ok: true, auditId: 9, code: null, after: { status: 'queued' } }),
    ).toEqual({
      ok: true,
      auditId: 9,
      after: { status: 'queued' },
    })
    expect(toAdminResult({ ok: true, auditId: 9, replayed: true })).toEqual({
      ok: true,
      auditId: 9,
      replayed: true,
    })
    expect(toAdminResult({ ok: false, auditId: 10, code: 'NOT_HELD', message: 'raw' })).toEqual({
      ok: false,
      auditId: 10,
      code: 'NOT_HELD',
      message: 'This refund is no longer held. Reload the page to see where it is.',
    })
    expect(toAdminResult(null)).toEqual({ ok: false, code: 'UNKNOWN', message: FALLBACK_WORDS })
    expect(toAdminResult({ ok: true })).toEqual({
      ok: false,
      code: 'UNKNOWN',
      message: FALLBACK_WORDS,
    })
    expect(refusedResult('DISABLED')).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'This check is off.',
    })
  })
})

describe('format', () => {
  const at = '2026-10-02T13:05:00Z'

  it('writes times in Lagos time, which never moves for summer', () => {
    expect(formatWat(at)).toBe('2 Oct 2026, 14:05 WAT')
    expect(formatWatTime(at)).toBe('14:05 WAT')
    expect(formatWatDate('2026-10-02T23:30:00Z')).toBe('3 Oct 2026')
    expect(formatWat('2026-01-15T23:00:00Z')).toBe('16 Jan 2026, 00:00 WAT')
    expect(formatWat(null)).toBe('—')
    expect(formatWat('not a date')).toBe('—')
    expect(formatWatTime(undefined)).toBe('—')
    expect(formatWatDate('')).toBe('—')
  })

  it('says how long ago, and how long until', () => {
    const now = new Date('2026-10-03T12:00:00Z')
    expect(ago('2026-10-03T11:59:30Z', now)).toBe('just now')
    expect(ago('2026-10-03T11:55:00Z', now)).toBe('5 min ago')
    expect(ago('2026-10-03T09:00:00Z', now)).toBe('3 h ago')
    expect(ago('2026-10-02T12:00:00Z', now)).toBe('1 day ago')
    expect(ago('2026-09-29T12:00:00Z', now)).toBe('4 days ago')
    expect(ago('2026-10-05T12:00:00Z', now)).toBe('in 2 days')
    expect(ago('2026-10-03T12:00:20Z', now)).toBe('in under a minute')
    expect(ago(null, now)).toBe('—')
  })

  it('writes dollars from integer cents', () => {
    expect(formatUsd(4338)).toBe('$43.38')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(null)).toBe('—')
  })

  it('masks an email exactly as SQL admin_mask_email does', () => {
    // The SQL: left(local, 1) || '•••@' || domain; no @ → '•••'.
    expect(ADMIN_SQL).toContain(
      "left(split_part(p_email, '@', 1), 1) || '•••@' || split_part(p_email, '@', 2)",
    )
    expect(maskEmail('ayang@gmail.com')).toBe('a•••@gmail.com')
    expect(maskEmail('é@example.ng')).toBe('é•••@example.ng')
    expect(maskEmail('😀x@example.com')).toBe('😀•••@example.com')
    expect(maskEmail('no-at-sign')).toBe('•••')
    expect(maskEmail(null)).toBe('—')
  })

  it('masks a phone to its last three digits', () => {
    expect(maskPhone('+234 803 123 4567')).toBe('•••• 567')
    expect(maskPhone('12')).toBe('••••')
    expect(maskPhone(undefined)).toBe('—')
  })

  it('shortens ids and counts', () => {
    expect(shortId('0f0e0d0c-0b0a-4908-8706-050403020100')).toBe('0f0e0d0c')
    expect(shortId(null)).toBe('—')
    expect(formatCount(12345.4)).toBe('12,345')
    expect(formatCount(undefined)).toBe('—')
  })
})

describe('list params', () => {
  const spec: ListSpec<'created_at' | 'total', 'paid' | 'failed'> = {
    sorts: ['created_at', 'total'],
    defaultSort: 'created_at',
    statuses: ['paid', 'failed'],
  }

  it('reads the defaults from an empty query', () => {
    expect(parseListParams({}, spec)).toEqual({
      sort: 'created_at',
      dir: 'desc',
      page: 1,
      per: 25,
      status: [],
      from: null,
      to: null,
    })
  })

  it('keeps only what the list knows', () => {
    const params = parseListParams(
      {
        sort: 'email',
        dir: 'sideways',
        page: '-3',
        per: '1000',
        status: ['paid,refunded', 'failed', 'paid'],
        from: '2026-02-30',
        to: '2026-10-01',
      },
      spec,
    )
    expect(params).toEqual({
      sort: 'created_at',
      dir: 'desc',
      page: 1,
      per: 25,
      status: ['paid', 'failed'],
      from: null,
      to: '2026-10-01',
    })
  })

  it('reads URLSearchParams too, caps the page and puts dates in order', () => {
    const params = parseListParams(
      new URLSearchParams('sort=total&dir=asc&page=99999&per=50&from=2026-10-02&to=2026-09-01'),
      spec,
    )
    expect(params).toMatchObject({
      sort: 'total',
      dir: 'asc',
      page: 10_000,
      per: 50,
      from: '2026-09-01',
      to: '2026-10-02',
    })
  })

  it('accepts only real calendar dates', () => {
    expect(validDate('2026-02-28')).toBe('2026-02-28')
    expect(validDate('2026-02-29')).toBeNull()
    expect(validDate('2026-2-1')).toBeNull()
    expect(validDate(undefined)).toBeNull()
  })

  it('pages', () => {
    expect(pageRange({ page: 3, per: 25 })).toEqual({ from: 50, to: 74 })
    expect(pageCount(0, 25)).toBe(1)
    expect(pageCount(51, 25)).toBe(3)
  })

  it('builds links from parsed values, leaving defaults out and going back to page 1 on a change', () => {
    const params = parseListParams({ page: '3', status: 'paid' }, spec)
    expect(listHref('/admin/orders', params, spec)).toBe('/admin/orders?status=paid&page=3')
    expect(listHref('/admin/orders', params, spec, { sort: 'total', dir: 'asc' })).toBe(
      '/admin/orders?status=paid&sort=total&dir=asc',
    )
    expect(listHref('/admin/orders', params, spec, { page: 4, per: 100 })).toBe(
      '/admin/orders?status=paid&per=100&page=4',
    )
    expect(
      listHref('/admin/orders', parseListParams({}, spec), spec, {
        from: '2026-09-01',
        to: '2026-09-30',
        extra: { line: 'abc', empty: '', none: null },
      }),
    ).toBe('/admin/orders?from=2026-09-01&to=2026-09-30&line=abc')
    expect(listHref('/admin/orders', parseListParams({}, spec), spec)).toBe('/admin/orders')
  })

  it('says how a column is sorted, and what clicking it does', () => {
    expect(ariaSort({ sort: 'total', dir: 'asc' }, 'total')).toBe('ascending')
    expect(ariaSort({ sort: 'total', dir: 'desc' }, 'total')).toBe('descending')
    expect(ariaSort({ sort: 'total', dir: 'desc' }, 'created_at')).toBe('none')
    expect(nextSort({ sort: 'total', dir: 'desc' }, 'total')).toEqual({ sort: 'total', dir: 'asc' })
    expect(nextSort({ sort: 'total', dir: 'asc' }, 'total')).toEqual({ sort: 'total', dir: 'desc' })
    expect(nextSort({ sort: 'total', dir: 'asc' }, 'created_at')).toEqual({
      sort: 'created_at',
      dir: 'desc',
    })
  })
})

describe('labels and tones', () => {
  it('gives every state a word, and shows an unknown one as itself', () => {
    expect(labelFor(REFUND_STATUS_LABEL, 'held')).toBe('Held for approval')
    expect(labelFor(JOB_KIND_LABEL, 'register_domain')).toBe('Registration')
    expect(labelFor(ROLE_LABEL, 'auditor')).toBe('auditor')
    expect(labelFor(REFUND_STATUS_LABEL, 'brand_new_state')).toBe('brand new state')
    expect(labelFor(REFUND_STATUS_LABEL, null)).toBe('—')
  })

  it('tones states from the status tokens only (S2)', () => {
    expect(toneOf('completed')).toBe('ok')
    expect(toneOf('needs_attention')).toBe('danger')
    expect(toneOf('held')).toBe('warning')
    expect(toneOf('queued')).toBe('info')
    expect(toneOf('mystery')).toBe('neutral')
    expect(toneOf(null)).toBe('neutral')
    for (const classes of Object.values(TONE_CLASS)) {
      expect(classes).toMatch(/status-/)
      expect(classes).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    }
  })
})

describe('playbook (DEPLOY §6)', () => {
  it('has an entry for every code DEPLOY §6 names', () => {
    for (const code of [
      'OVER_SINGLE_LIMIT',
      'OVER_DAILY_LIMIT',
      'REGISTERED_AT_REGISTRY',
      'CHARGE_NOT_OURS',
      'CHARGE_NOT_FOUND',
      'CHARGEBACK_ON_CHARGE',
      'REFUND_OUTCOME_UNKNOWN',
      'UNTRACKED_REFUND_AT_PROVIDER',
      'ALREADY_AT_PROVIDER',
      'AMOUNT_MISMATCH',
      'PROVIDER_REFUND_FAILED',
      'INSUFFICIENT_BALANCE',
      'PAYMENT_NOT_VERIFIED',
      'TRANSFER_OVERDUE',
      'CONTACTS_NOT_VISIBLE',
      'NOT_RENEWABLE',
    ]) {
      expect(PLAYBOOK[code], code).toBeDefined()
    }
  })

  it('offers Retry only for an unconfirmed charge, in the words the spec gives', () => {
    const entry = playbookFor('PAYMENT_NOT_VERIFIED')
    expect(entry.offers).toEqual(['retry_job'])
    expect(entry.next).toBe(
      'Retry re-reads the charge from Flutterwave. If it still can’t be confirmed, the owner closes it in the SQL editor (DEPLOY §6).',
    )
  })

  it('sends a landed transfer to the SQL editor and offers the read', () => {
    const entry = playbookFor('TRANSFER_OVERDUE')
    expect(entry.offers).toEqual(['read_transfer_state', 'fail_job'])
    expect(entry.next).toContain('complete_transfer')
  })

  it('offers the renewability check, and a retry for a registration the registry has', () => {
    expect(playbookFor('NOT_RENEWABLE').offers).toEqual(['check_renewable'])
    expect(playbookFor('REGISTERED_AT_REGISTRY').offers).toContain('retry_job')
  })

  it('reads a Flutterwave HTTP code by its prefix, and anything else as unknown', () => {
    expect(playbookFor('FLW_HTTP_400').offers).toEqual(['retry_refund'])
    expect(playbookFor('SOMETHING_NEW')).toBe(NO_PLAYBOOK)
    expect(playbookFor(null).meaning).toBe(
      'No playbook entry — read the job’s supplier calls first.',
    )
  })
})

describe('side', () => {
  it('reads the cookie, and keeps a test admin on the test side (D15)', () => {
    expect(parseSide('test')).toBe('test')
    expect(parseSide('LIVE')).toBe('live')
    expect(parseSide(undefined)).toBe('live')
    expect(sideFor({ testOnly: true }, 'live')).toBe('test')
    expect(sideFor({ testOnly: false }, 'test')).toBe('test')
  })

  it('words the banner', () => {
    expect(sideBanner({ testOnly: false }, 'live')).toBeNull()
    expect(sideBanner({ testOnly: false }, 'test')).toBe(TEST_SIDE_BANNER)
    expect(TEST_SIDE_BANNER).toBe('Showing test-mode records — no real money')
    expect(sideBanner({ testOnly: true }, 'test')).toBe(TEST_ADMIN_BANNER)
  })

  it('keeps the cookie to /admin, out of scripts', () => {
    expect(SIDE_COOKIE_OPTIONS).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/admin',
      maxAge: 30 * 24 * 60 * 60,
    })
  })
})

describe('href', () => {
  const id = '0F0E0D0C-0B0A-4908-8706-050403020100'

  it('links by id, never by a name, and drops anything that is not an id', () => {
    expect(adminHref.order(id)).toBe('/admin/orders/0f0e0d0c-0b0a-4908-8706-050403020100')
    expect(adminHref.order('example.com')).toBe('/admin/orders')
    expect(adminHref.domain(null)).toBe('/admin/domains')
    expect(adminHref.refund(id)).toMatch(/^\/admin\/refunds\//)
    expect(adminHref.job(id)).toMatch(/^\/admin\/queue\/jobs\//)
    expect(adminHref.sslJob(id)).toMatch(/^\/admin\/queue\/ssl-jobs\//)
    expect(adminHref.customer(id)).toMatch(/^\/admin\/customers\//)
    expect(adminHref.certificate(id)).toMatch(/^\/admin\/ssl\//)
    expect(adminHref.preset(id)).toMatch(/^\/admin\/settings\/presets\//)
    expect(adminHref.incident(12)).toBe('/admin/refunds/incidents#incident-12')
    expect(adminHref.incident('x')).toBe('/admin/refunds/incidents')
    expect(adminHref.audit('42')).toBe('/admin/audit?id=42')
    expect(adminHref.audit(undefined)).toBe('/admin/audit')
    expect(adminHref.overview()).toBe('/admin')
    expect(adminHref.alert('admin_burst:ops')).toBe('/admin/audit?label=ops')
  })
})
