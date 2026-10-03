import type { AdminRegistryDomain, AdminTransferState } from '@dr/shared/admin'
import { describe, expect, it } from 'vitest'
import { ADMIN_ERROR_WORDS } from '@/features/admin/lib/errors'
import {
  FAILED_TRANSFER_WORDS,
  failCopy,
  failOffer,
  failRequirement,
  isSslKind,
  type JobFacts,
  lastReadWords,
  ONLY_RETRY_WORDS,
  RETRY_DONE,
  readVerdictWords,
  registryReadWords,
  renewCheckWords,
  retryBody,
  retryOffer,
  retryTitle,
  transferStateWords,
} from '@/features/admin/lib/jobs-copy'

/** A job needing a person, for example.com, with nothing on its line yet. */
function job(overrides: Partial<JobFacts> = {}): JobFacts {
  return {
    kind: 'register_domain',
    status: 'needs_attention',
    lastErrorCode: 'SUPPLIER_TIMEOUT',
    name: 'example.com',
    pendingRefundKobo: null,
    refundAtProvider: false,
    failRefundKobo: 1_075_000,
    pendingTransferLock: null,
    sentAt: null,
    ...overrides,
  }
}

describe('Retry, by kind (ADMIN-SPEC §5.2 B4)', () => {
  it.each([
    ['register_domain', 'Try the registration of example.com again?'],
    ['renew_domain', 'Try the renewal of example.com again?'],
    ['transfer_domain', 'Try the transfer of example.com again?'],
    ['apply_nameservers', 'Try the nameserver change for example.com again?'],
    ['set_transfer_lock', 'Try the transfer lock change for example.com again?'],
    ['set_privacy', 'Try the privacy change for example.com again?'],
    ['update_contacts', 'Try the contact change for example.com again?'],
    ['ssl_initialize', 'Try the certificate order for example.com again?'],
    ['ssl_configure', 'Try the certificate set-up for example.com again?'],
    ['ssl_reissue', 'Try the certificate reissue for example.com again?'],
  ])('titles a %s retry "%s"', (kind, title) => {
    expect(retryTitle({ kind, name: 'example.com' })).toBe(title)
  })

  it('names "this domain" or "this certificate" when the name is unknown', () => {
    expect(retryTitle({ kind: 'register_domain', name: null })).toBe(
      'Try the registration of this domain again?',
    )
    expect(retryTitle({ kind: 'ssl_initialize', name: null })).toBe(
      'Try the certificate order for this certificate again?',
    )
    expect(retryTitle({ kind: 'something_new', name: 'example.com' })).toBe(
      'Try this job for example.com again?',
    )
  })

  it('says a failed registration is read first, and its pending refund cancelled first', () => {
    expect(
      retryBody(job({ status: 'failed', pendingRefundKobo: 1_075_000, lastErrorCode: 'X' })),
    ).toBe(
      'The worker reads the registry first: if example.com is already in our account it is recorded, not bought again. Its pending refund of ₦10,750 is cancelled first; this is refused if that refund has reached Flutterwave.',
    )
    expect(retryBody(job({ status: 'failed', pendingRefundKobo: null }))).toBe(
      'The worker reads the registry first: if example.com is already in our account it is recorded, not bought again.',
    )
  })

  it('says a registration waiting for a person — PAYMENT_NOT_VERIFIED included — re-reads the charge and the registry', () => {
    const words =
      'The worker re-reads the charge from Flutterwave and the registry, and registers only if both allow it.'
    expect(retryBody(job())).toBe(words)
    expect(retryBody(job({ lastErrorCode: 'PAYMENT_NOT_VERIFIED' }))).toBe(words)
  })

  it('says a renewal compares the expiry first, and a failed one cancels its refund', () => {
    const words =
      "The worker compares the registry's expiry with the one stored before renewing, and renews only if it hasn't moved."
    expect(retryBody(job({ kind: 'renew_domain' }))).toBe(words)
    expect(
      retryBody(job({ kind: 'renew_domain', status: 'failed', pendingRefundKobo: 500_000 })),
    ).toBe(
      `${words} Its pending refund of ₦5,000 is cancelled first; this is refused if that refund has reached Flutterwave.`,
    )
  })

  it('says a waiting transfer never sends its code again', () => {
    expect(retryBody(job({ kind: 'transfer_domain' }))).toBe(
      "The worker reads the transfer's state; once submitted it never sends the code again.",
    )
  })

  it.each(['apply_nameservers', 'set_transfer_lock', 'set_privacy', 'update_contacts'])(
    'says a %s retry reads the registry and records what it shows',
    (kind) => {
      expect(retryBody(job({ kind }))).toBe(
        "The worker reads the registry, makes the change if it's still needed, and records what the registry shows.",
      )
    },
  )

  it('says a certificate job never buys twice', () => {
    const words =
      'If the order was already sent, the worker only reads its status — it never buys twice.'
    expect(retryBody(job({ kind: 'ssl_configure' }))).toBe(words)
    expect(retryBody(job({ kind: 'ssl_reissue' }))).toBe(words)
    expect(retryBody(job({ kind: 'ssl_initialize' }))).toBe(words)
    expect(retryBody(job({ kind: 'ssl_initialize', status: 'failed' }))).toBe(
      `${words} A refund still pending for it is cancelled first; this is refused if that refund has reached Flutterwave.`,
    )
    expect(retryBody(job({ kind: 'mystery' }))).toBe(
      'The worker picks the job up again on its next run.',
    )
  })

  it('is offered for a job that failed or needs a person, with Retry / Not now', () => {
    const offer = retryOffer(job())
    expect(offer).toEqual({
      offered: true,
      copy: {
        title: 'Try the registration of example.com again?',
        body: 'The worker re-reads the charge from Flutterwave and the registry, and registers only if both allow it.',
        confirmLabel: 'Retry',
        cancelLabel: 'Not now',
        done: RETRY_DONE,
      },
    })
    expect(retryOffer(job({ status: 'failed' })).offered).toBe(true)
  })

  it('is not offered, and says nothing, while the worker has the job or it is done', () => {
    for (const status of ['queued', 'running', 'succeeded']) {
      expect(retryOffer(job({ status }))).toEqual({ offered: false, words: null })
    }
  })

  it('is not offered for a failed transfer: its code is gone', () => {
    expect(retryOffer(job({ kind: 'transfer_domain', status: 'failed' }))).toEqual({
      offered: false,
      words:
        "A failed transfer can't be retried: its transfer code was deleted. The customer starts a new transfer.",
    })
    expect(FAILED_TRANSFER_WORDS).toBe(
      "A failed transfer can't be retried: its transfer code was deleted. The customer starts a new transfer.",
    )
    // A transfer waiting for a person is retried.
    expect(retryOffer(job({ kind: 'transfer_domain' })).offered).toBe(true)
  })

  it('is not offered once the line refund has reached Flutterwave', () => {
    expect(retryOffer(job({ status: 'failed', refundAtProvider: true }))).toEqual({
      offered: false,
      words: ADMIN_ERROR_WORDS.REFUND_AT_PROVIDER,
    })
  })
})

describe('Fail, and when it is offered', () => {
  it.each([
    ['renew_domain', {}],
    ['apply_nameservers', {}],
    ['set_transfer_lock', { pendingTransferLock: false }],
    ['set_transfer_lock', { pendingTransferLock: null }],
  ] as const)('is hidden for %s %j: only Retry, in the spec words', (kind, extra) => {
    expect(failOffer(job({ kind, ...extra }))).toEqual({
      offered: false,
      words: ONLY_RETRY_WORDS,
    })
    expect(ONLY_RETRY_WORDS).toBe(
      'Only Retry is offered: stopping this could block a transfer-out, or leave a change half-recorded.',
    )
  })

  it('is hidden for PAYMENT_NOT_VERIFIED, whatever the kind: the owner closes it in SQL (D20)', () => {
    for (const kind of ['register_domain', 'transfer_domain', 'set_privacy', 'ssl_initialize']) {
      expect(failOffer(job({ kind, lastErrorCode: 'PAYMENT_NOT_VERIFIED' }))).toEqual({
        offered: false,
        words: ADMIN_ERROR_WORDS.PAYMENT_NOT_VERIFIED,
      })
    }
  })

  it('is hidden for a job that is not waiting for a person', () => {
    for (const status of ['failed', 'queued', 'running', 'succeeded']) {
      expect(failOffer(job({ status }))).toEqual({ offered: false, words: null })
    }
  })

  it('is hidden for a certificate order that may have reached the supplier (N3)', () => {
    expect(failOffer(job({ kind: 'ssl_initialize', sentAt: '2026-10-03T10:00:00Z' }))).toEqual({
      offered: false,
      words: ADMIN_ERROR_WORDS.ALREADY_SENT,
    })
  })

  it('fails a registration with its refund named, after a registry read', () => {
    const offer = failOffer(job())
    expect(offer).toEqual({
      offered: true,
      copy: {
        title: 'Fail the registration of example.com and refund ₦10,750?',
        body: 'The line fails, the customer is told nothing was bought, and a refund of ₦10,750 is queued to the card or account that paid.',
        trigger: 'Fail',
        confirmLabel: 'Fail and refund ₦10,750',
        needsRead: 'registry',
        done: 'Failed. The refund is queued to the card or account that paid.',
      },
    })
  })

  it('fails a transfer the registry refused, after a transfer state read', () => {
    expect(failCopy(job({ kind: 'transfer_domain' }))).toMatchObject({
      title: 'Fail the transfer of example.com and refund ₦10,750?',
      body: "The registry refused it, so the domain didn't move to us. The customer is told and a refund of ₦10,750 is queued.",
      confirmLabel: 'Fail and refund ₦10,750',
      needsRead: 'transfer',
    })
  })

  it('names no figure when the refund cannot be told', () => {
    expect(failCopy(job({ failRefundKobo: null }))).toMatchObject({
      title: 'Fail the registration of example.com and refund the amount paid for it?',
      confirmLabel: 'Fail and refund',
    })
  })

  it.each([
    ['set_transfer_lock', 'Stop this transfer lock change?', { pendingTransferLock: true }],
    ['set_privacy', 'Stop this privacy change?', {}],
    ['update_contacts', 'Stop this contact change?', {}],
  ] as const)('stops a %s: "%s"', (kind, title, extra) => {
    expect(failOffer(job({ kind, ...extra }))).toEqual({
      offered: true,
      copy: {
        title,
        body: 'The change is dropped; the domain keeps what the registry shows. The customer can ask again.',
        trigger: 'Stop the change',
        confirmLabel: 'Stop the change',
        needsRead: null,
        done: 'Stopped. Nothing more is sent for this change.',
      },
    })
  })

  it('fails an unsent certificate order, and stops a set-up or reissue', () => {
    expect(failCopy(job({ kind: 'ssl_initialize' }))).toMatchObject({
      title: 'Fail the certificate order for example.com?',
      confirmLabel: 'Fail the order',
      needsRead: null,
    })
    expect(failCopy(job({ kind: 'ssl_configure' }))).toMatchObject({
      title: 'Stop this certificate set-up?',
      body: 'The request is dropped; the certificate keeps what the supplier shows. The customer can ask again.',
    })
    expect(failCopy(job({ kind: 'ssl_reissue' }))?.title).toBe('Stop this certificate reissue?')
    expect(failCopy(job({ kind: 'mystery' }))).toBeNull()
    expect(failOffer(job({ kind: 'mystery' }))).toEqual({
      offered: false,
      words: ONLY_RETRY_WORDS,
    })
  })

  it('knows the certificate kinds', () => {
    expect(isSslKind('ssl_reissue')).toBe(true)
    expect(isSslKind('register_domain')).toBe(false)
  })
})

describe('the read Fail needs, in words', () => {
  it('says what each kind needs', () => {
    expect(failRequirement('registry')).toBe(
      'Fail needs a registry read in the last 15 minutes, after the last registration attempt, that finds the domain is not in our account.',
    )
    expect(failRequirement('transfer')).toBe(
      'Fail needs a transfer state read in the last 15 minutes, after the last transfer attempt, that finds the registry refused or cancelled it.',
    )
  })

  it.each([
    ['none', 'registry', 'No registry read is recorded for this domain on this side.'],
    ['stale', 'transfer', 'The last transfer state read is over 15 minutes old. Read it again.'],
    [
      'before_attempt',
      'registry',
      "The last registry read came before the job's last attempt. Read it again.",
    ],
    [
      'not_qualifying',
      'registry',
      'The last registry read did not find it missing, so Fail is refused. Retry instead: in our account, it is recorded.',
    ],
    [
      'not_qualifying',
      'transfer',
      'The last transfer state read did not show a refusal, so Fail is refused.',
    ],
    ['ok', 'registry', 'The last registry read is recent and allows Fail.'],
  ] as const)('words the %s verdict for a %s read', (verdict, read, words) => {
    expect(readVerdictWords(verdict, read)).toBe(words)
  })
})

describe('the last read on record', () => {
  const at = '2026-10-03T11:58:00Z'

  it('says when and what it found', () => {
    expect(lastReadWords('registry', null)).toBeNull()
    expect(lastReadWords('registry', { createdAt: at, outcome: 'not_found' })).toBe(
      'Last registry read: 3 Oct 2026, 12:58 WAT (not in our account).',
    )
    expect(lastReadWords('registry', { createdAt: at, outcome: 'ok' })).toBe(
      'Last registry read: 3 Oct 2026, 12:58 WAT (in our account).',
    )
    expect(lastReadWords('registry', { createdAt: at, outcome: 'timed_out' })).toBe(
      'Last registry read: 3 Oct 2026, 12:58 WAT (answered timed out).',
    )
    expect(lastReadWords('transfer', { createdAt: at, outcome: 'ok', state: 'rejected' })).toBe(
      'Last transfer state read: 3 Oct 2026, 12:58 WAT (rejected).',
    )
    expect(lastReadWords('transfer', { createdAt: at, outcome: 'unknown', state: null })).toBe(
      'Last transfer state read: 3 Oct 2026, 12:58 WAT (answered unknown).',
    )
  })
})

describe('what a live read found', () => {
  const at = '2026-10-03T13:05:00.000Z'

  it('words a registry read: not ours, or ours with its expiry', () => {
    const base: AdminRegistryDomain = {
      name: 'example.com',
      outcome: 'not_found',
      status: null,
      statusCode: null,
      expiresAt: null,
      rgpExpiresAt: null,
      transferLock: null,
      privacy: null,
      nameservers: [],
      readAt: at,
    }
    expect(registryReadWords(base)).toBe('Read at 14:05 WAT: not in our account')
    expect(
      registryReadWords({ ...base, outcome: 'ok', expiresAt: '2027-10-01T10:00:00Z' }),
    ).toMatch(/^Read at 14:05 WAT: in our account, expires 1 Oct 2027$/)
    expect(registryReadWords({ ...base, outcome: 'ok' })).toBe('Read at 14:05 WAT: in our account')
  })

  it('words each transfer state', () => {
    const base: AdminTransferState = {
      name: 'example.com',
      state: 'rejected',
      supplierStatus: 'rejected',
      requestedAt: '2026-09-20T09:00:00.000Z',
      finalAt: '2026-09-30T09:00:00.000Z',
      readAt: at,
    }
    expect(transferStateWords(base)).toMatch(
      /^Read at 14:05 WAT: refused by the registry on 30 Sept? 2026$/,
    )
    expect(transferStateWords({ ...base, finalAt: null })).toBe(
      'Read at 14:05 WAT: refused by the registry',
    )
    expect(transferStateWords({ ...base, state: 'cancelled' })).toMatch(
      /^Read at 14:05 WAT: cancelled at the registry on 30 Sept? 2026$/,
    )
    expect(transferStateWords({ ...base, state: 'completed' })).toBe(
      'Read at 14:05 WAT: landed — record it in the SQL editor (DEPLOY §6)',
    )
    expect(transferStateWords({ ...base, state: 'pending' })).toMatch(
      /^Read at 14:05 WAT: still waiting at the registry \(asked on 20 Sept? 2026\)$/,
    )
    expect(transferStateWords({ ...base, state: 'pending', requestedAt: null })).toBe(
      'Read at 14:05 WAT: still waiting at the registry',
    )
    expect(transferStateWords({ ...base, state: 'unknown' })).toBe(
      "Read at 14:05 WAT: the registry's answer didn't say where the transfer stands",
    )
  })

  it('words a renewability check', () => {
    const base = {
      name: 'example.com',
      renewable: true,
      renewalLock: false,
      reasonKey: null,
      readAt: at,
    }
    expect(renewCheckWords(base)).toBe('Read at 14:05 WAT: the registry would renew it')
    expect(renewCheckWords({ ...base, renewalLock: true })).toBe(
      'Read at 14:05 WAT: the registry would not renew it — renewal is locked',
    )
    expect(renewCheckWords({ ...base, renewable: false, reasonKey: 'PERIOD_NOT_ALLOWED' })).toBe(
      "Read at 14:05 WAT: the registry would not renew it — the registry doesn't allow that period",
    )
    expect(renewCheckWords({ ...base, renewable: false, reasonKey: 'NOT_RENEWABLE' })).toBe(
      'Read at 14:05 WAT: the registry would not renew it',
    )
    expect(renewCheckWords({ ...base, renewable: false })).toBe(
      'Read at 14:05 WAT: the registry would not renew it',
    )
  })
})
