import { SSL_STATUSES } from '@dr/shared'
import type { AdminSslStatus } from '@dr/shared/admin'
import { describe, expect, it } from 'vitest'
import * as copy from '@/features/admin/lib/ssl-copy'
import {
  CERTIFICATE_STATUS_LABEL,
  callOutcomeTone,
  certificateState,
  daysUntil,
  expiryWords,
  lastReadWords,
  NO_CERTIFICATES,
  NO_CERTIFICATES_BODY,
  STATUS_SENTENCE,
  statusReadWords,
  statusSentence,
  supplierWordLabel,
  supplierWordText,
  unrecognisedHint,
} from '@/features/admin/lib/ssl-copy'

const NOW = new Date('2026-10-03T12:00:00Z')
const READ_AT = '2026-10-03T11:05:00.000Z'

const read = (overrides: Partial<AdminSslStatus> = {}): AdminSslStatus => ({
  name: 'shop.example.com',
  outcome: 'ok',
  status: 'Active',
  isConfigured: true,
  isIssued: true,
  certificateExpiresAt: '2027-04-20T10:00:00Z',
  subscriptionEndsAt: '2027-10-01T10:00:00Z',
  validUntil: null,
  readAt: READ_AT,
  ...overrides,
})

/** Every string the module exports, and what its functions say for a spread of inputs. */
function everyWord(): string[] {
  const words: string[] = []
  for (const value of Object.values(copy)) {
    if (typeof value === 'string') words.push(value)
    else if (value && typeof value === 'object') {
      for (const inner of Object.values(value)) if (typeof inner === 'string') words.push(inner)
    }
  }
  for (const status of [...SSL_STATUSES, 'mystery']) words.push(statusSentence(status))
  words.push(
    statusReadWords(read()),
    statusReadWords(read({ outcome: 'not_found' })),
    statusReadWords(read({ status: 'Mystery', isIssued: false, isConfigured: false })),
    unrecognisedHint('NotFound'),
    unrecognisedHint('Mystery'),
    NO_CERTIFICATES('test'),
    NO_CERTIFICATES_BODY('live'),
    NO_CERTIFICATES_BODY('test'),
  )
  return words
}

describe('the certificate pages’ words', () => {
  it('never say a certificate is valid for a year: the term comes from SSL_TERM only', () => {
    for (const words of everyWord()) {
      expect(words).not.toMatch(/valid for (a|one|1) year/i)
      expect(words).not.toMatch(/year of validity|valid(ity)? (until|for) .*year/i)
      expect(words).not.toMatch(/renews? (automatically|by itself)/i)
    }
  })

  it('name every status the database holds', () => {
    for (const status of SSL_STATUSES) {
      expect(CERTIFICATE_STATUS_LABEL[status], status).toBeTruthy()
      expect(STATUS_SENTENCE[status], status).toBeTruthy()
    }
    expect(statusSentence('mystery')).toBe(
      'This status has no words here yet. Read the certificate’s jobs and supplier calls.',
    )
    expect(statusSentence(null)).toBe(statusSentence('mystery'))
  })
})

describe('certificateState', () => {
  it('words each status, with a tone that is never the only signal', () => {
    expect(certificateState('awaiting_validation', null, NOW)).toEqual({
      value: 'awaiting_validation',
      label: 'Waiting for approval',
      tone: 'info',
    })
    expect(certificateState('failed', null, NOW)).toEqual({
      value: 'failed',
      label: 'Not ordered',
      tone: 'danger',
    })
    expect(certificateState('mystery_state', null, NOW)).toEqual({
      value: 'mystery_state',
      label: 'mystery state',
      tone: 'neutral',
    })
    expect(certificateState(null, null, NOW).label).toBe('—')
  })

  it('says Expired for an issued certificate past its date, and warns close to it', () => {
    expect(certificateState('issued', '2026-10-03T11:59:00Z', NOW)).toEqual({
      value: 'expired',
      label: 'Expired',
      tone: 'danger',
    })
    expect(certificateState('issued', '2026-10-20T12:00:00Z', NOW)).toEqual({
      value: 'issued',
      label: 'Issued',
      tone: 'warning',
    })
    expect(certificateState('issued', '2027-04-20T10:00:00Z', NOW).tone).toBe('ok')
    expect(certificateState('issued', null, NOW).tone).toBe('ok')
  })
})

describe('expiry', () => {
  it('counts whole days, and none without a date', () => {
    expect(daysUntil('2026-10-05T12:00:00Z', NOW)).toBe(2)
    expect(daysUntil(null, NOW)).toBeNull()
    expect(daysUntil('not a date', NOW)).toBeNull()
  })

  it('says when, and how long until', () => {
    expect(expiryWords(null, NOW)).toBe('Not issued yet')
    expect(expiryWords('2026-10-04T12:00:00Z', NOW)).toBe('4 Oct 2026 (in 1 day)')
    expect(expiryWords('2026-10-13T12:00:00Z', NOW)).toBe('13 Oct 2026 (in 10 days)')
    expect(expiryWords('2026-10-03T20:00:00Z', NOW)).toBe('3 Oct 2026 (today)')
    expect(expiryWords('2026-10-01T12:00:00Z', NOW)).toBe('Expired on 1 Oct 2026')
  })
})

describe('the supplier’s word', () => {
  it('is put in our words, whatever its case or spacing', () => {
    expect(supplierWordLabel('WaitingForInstall')).toBe('Waiting for set-up')
    expect(supplierWordLabel('waiting_for_validation')).toBe('Waiting for approval')
    expect(supplierWordLabel(' Active ')).toBe('Active')
    expect(supplierWordLabel('Canceled')).toBe('Cancelled')
    expect(supplierWordLabel('NotFound')).toBe('Not found at DomainNameAPI')
    expect(supplierWordLabel('Mystery')).toBeNull()
    expect(supplierWordLabel(null)).toBeNull()
  })

  it('is never shown as sent (N10)', () => {
    expect(supplierWordText('Active', null)).toBe('Active')
    expect(supplierWordText(null, null)).toBe('Not read yet')
    expect(supplierWordText('PendingSomethingNew', null)).toBe('Not a word we know')
    const since = supplierWordText('PendingSomethingNew', '2026-10-02T09:00:00Z')
    expect(since).toBe('Not a word we know (since 2 Oct 2026, 10:00 WAT)')
    expect(since).not.toContain('PendingSomethingNew')
    expect(supplierWordText('NotFound', '2026-10-02T09:00:00Z')).toBe(
      'Not found at DomainNameAPI (since 2 Oct 2026, 10:00 WAT)',
    )
  })

  it('explains a word the gateway could not place, and what follows', () => {
    expect(unrecognisedHint('NotFound')).toBe(
      'DomainNameAPI found no certificate under this name. Its status here stays as it was; after a day this raises an alert.',
    )
    expect(unrecognisedHint('Mystery')).toContain(
      'after a day this raises an alert that names the word',
    )
  })
})

describe('statusReadWords', () => {
  it('says what a read found, in our words, with the read time in WAT', () => {
    expect(statusReadWords(read())).toBe(
      'Read at 12:05 WAT: Active — issued; the certificate expires 20 Apr 2027; the subscription ends 1 Oct 2027',
    )
    expect(statusReadWords(read({ outcome: 'not_found', status: null }))).toBe(
      'Read at 12:05 WAT: DomainNameAPI has no certificate under this name',
    )
    expect(
      statusReadWords(
        read({
          status: 'WaitingForValidation',
          isIssued: false,
          isConfigured: true,
          certificateExpiresAt: null,
          subscriptionEndsAt: null,
        }),
      ),
    ).toBe('Read at 12:05 WAT: Waiting for approval — set up, not issued yet')
    expect(
      statusReadWords(
        read({
          status: 'WaitingForInstall',
          isIssued: false,
          isConfigured: false,
          certificateExpiresAt: null,
          subscriptionEndsAt: '2027-10-01T10:00:00Z',
        }),
      ),
    ).toBe(
      'Read at 12:05 WAT: Waiting for set-up — not set up yet; the subscription ends 1 Oct 2027',
    )
  })

  it('takes the certificate’s own date when check-status has none, and never repeats a word it does not know', () => {
    const words = statusReadWords(
      read({
        status: 'BrandNewWord',
        isIssued: null,
        isConfigured: null,
        certificateExpiresAt: null,
        validUntil: '2027-04-21T10:00:00Z',
        subscriptionEndsAt: null,
      }),
    )
    expect(words).toBe(
      'Read at 12:05 WAT: a status word we don’t know — the certificate expires 21 Apr 2027',
    )
    expect(words).not.toContain('BrandNewWord')
    expect(
      statusReadWords(
        read({
          isIssued: null,
          isConfigured: null,
          certificateExpiresAt: null,
          subscriptionEndsAt: null,
        }),
      ),
    ).toBe('Read at 12:05 WAT: Active')
  })
})

describe('lastReadWords and call outcomes', () => {
  it('says when an admin last read the status, or that nobody has', () => {
    expect(lastReadWords(null)).toBe('No admin has read its status from DomainNameAPI yet.')
    expect(lastReadWords({ createdAt: READ_AT, outcome: 'ok' })).toBe(
      'Last read by an admin: 3 Oct 2026, 12:05 WAT (found).',
    )
    expect(lastReadWords({ createdAt: READ_AT, outcome: 'not_found' })).toContain('(not found)')
    expect(lastReadWords({ createdAt: READ_AT, outcome: 'blocked_by_x' })).toContain(
      '(blocked by x)',
    )
  })

  it('tints each outcome', () => {
    expect(callOutcomeTone('ok')).toBe('ok')
    expect(callOutcomeTone('not_found')).toBe('info')
    expect(callOutcomeTone('unknown')).toBe('warning')
    expect(callOutcomeTone('rejected')).toBe('danger')
    expect(callOutcomeTone('blocked')).toBe('danger')
    expect(callOutcomeTone('other')).toBe('neutral')
  })
})
