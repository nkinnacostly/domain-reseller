import { TRANSFER_LOCK_DAYS, transferEligibleAt } from '@dr/shared'
import type { RdapLookup, RdapRecord } from './rdap'

/**
 * Transfer-in eligibility (PRD FR-T1, FR-T7).
 *
 * "A checklist, not a form" (PRD §15.3): each item is met, blocked with the
 * specific reason and — where time is the only blocker — the exact date it
 * clears, or something only the owner can confirm. Pure: the caller does the
 * lookups and passes `now`, so every rule is testable to the day.
 *
 * What this cannot see: the auth code, and a change of registrant (RDAP does
 * not publish one). Those stay `manual` until checkout runs the supplier's
 * CheckTransfer, which is the final word before any money moves (FR-T1).
 */

export type CheckId = 'extension' | 'registered' | 'unlocked' | 'window' | 'status' | 'auth-code'

/** `manual` — true or not, only the owner or their registrar can tell. */
export type CheckState = 'pass' | 'fail' | 'manual'

export type TransferCheck = {
  id: CheckId
  state: CheckState
  title: string
  detail: string
  /** ISO date a time-bound block clears. Null for anything else. */
  unblocksAt: string | null
}

export type TransferOutcome =
  | 'ready'
  | 'blocked'
  | 'needs-confirmation'
  | 'not-registered'
  | 'unsupported-extension'

export type TransferVerdict = {
  domain: string
  tld: string
  outcome: TransferOutcome
  checks: TransferCheck[]
  /** When every blocker is a waiting period: the day the last one clears. */
  opensOn: string | null
  registrar: string | null
  expiresAt: string | null
}

/**
 * Whether we can bring this extension in. `unknown` when the catalogue could
 * not be read — we do not guess either way.
 */
export type ExtensionOffer = 'offered' | 'not-offered' | 'unknown'

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
})

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso))
}

const AUTH_CODE: TransferCheck = {
  id: 'auth-code',
  state: 'manual',
  title: 'You have the auth code',
  detail:
    'Your current registrar gives you this code — it may be called the EPP code, transfer code or authorisation code. They must hand it over within five days of you asking.',
  unblocksAt: null,
}

function extensionCheck(tld: string, offer: ExtensionOffer): TransferCheck {
  const title = `We take transfers for .${tld}`
  if (offer === 'offered') {
    return {
      id: 'extension',
      state: 'pass',
      title,
      detail: 'The registry allows transfers, and we can bring it in.',
      unblocksAt: null,
    }
  }
  if (offer === 'not-offered') {
    return {
      id: 'extension',
      state: 'fail',
      title,
      detail: `We don't take transfers for .${tld} yet.`,
      unblocksAt: null,
    }
  }
  return {
    id: 'extension',
    state: 'manual',
    title,
    detail:
      'Our price list is unavailable right now, so we cannot confirm this one. Try again in a few minutes.',
    unblocksAt: null,
  }
}

function lockCheck(record: RdapRecord | null, registrar: string): TransferCheck {
  const title = 'Transfer lock is off'
  if (!record) {
    return {
      id: 'unlocked',
      state: 'manual',
      title,
      detail:
        "In your current registrar's dashboard, turn off the transfer lock — it may be called registrar lock or domain lock.",
      unblocksAt: null,
    }
  }

  const clientLock = record.statuses.includes('client transfer prohibited')
  const serverLock = record.statuses.includes('server transfer prohibited')

  if (serverLock) {
    return {
      id: 'unlocked',
      state: 'fail',
      title,
      detail: `The registry has locked it, and only your registrar can ask for that lock to be lifted. Contact ${registrar}${clientLock ? ', and turn off the transfer lock while you are there' : ''}, then check again.`,
      unblocksAt: null,
    }
  }
  if (clientLock) {
    return {
      id: 'unlocked',
      state: 'fail',
      title,
      detail: `${capitalise(registrar)} has it locked. Turn off the transfer lock in their dashboard — it may be called registrar lock or domain lock — then check again.`,
      unblocksAt: null,
    }
  }
  return {
    id: 'unlocked',
    state: 'pass',
    title,
    detail: 'Nothing is stopping it leaving your current registrar.',
    unblocksAt: null,
  }
}

function windowCheck(record: RdapRecord | null, now: Date): TransferCheck {
  const title = `Not registered or transferred in the last ${TRANSFER_LOCK_DAYS} days`
  const manual: TransferCheck = {
    id: 'window',
    state: 'manual',
    title,
    detail: `Registrars can refuse a transfer within ${TRANSFER_LOCK_DAYS} days of a domain being registered or last transferred. Check the date with your current registrar.`,
    unblocksAt: null,
  }
  if (!record?.registeredAt) return manual

  // The later of the two events is the one that starts the clock.
  const transferredLast =
    record.lastTransferredAt !== null && record.lastTransferredAt > record.registeredAt
  const since = transferredLast ? (record.lastTransferredAt as string) : record.registeredAt
  const opens = transferEligibleAt(new Date(since))
  const what = transferredLast ? 'It last changed registrar' : 'It was registered'

  if (now < opens) {
    return {
      id: 'window',
      state: 'fail',
      title,
      detail: `${what} on ${formatDate(since)}. Registrars can refuse a transfer for ${TRANSFER_LOCK_DAYS} days after that, so it can move from ${formatDate(opens.toISOString())}.`,
      unblocksAt: opens.toISOString(),
    }
  }
  return {
    id: 'window',
    state: 'pass',
    title,
    detail: `${what} on ${formatDate(since)}.`,
    unblocksAt: null,
  }
}

function statusCheck(record: RdapRecord | null, now: Date): TransferCheck {
  const title = 'Not expired, being deleted or already moving'
  if (!record) {
    return {
      id: 'status',
      state: 'manual',
      title,
      detail:
        'Make sure it has not expired and is not in a redemption period. An expired domain has to be renewed or restored where it is first.',
      unblocksAt: null,
    }
  }

  const has = (status: string) => record.statuses.includes(status)
  const fail = (detail: string): TransferCheck => ({
    id: 'status',
    state: 'fail',
    title,
    detail,
    unblocksAt: null,
  })

  if (has('pending delete')) {
    return fail(
      'The registry is deleting it, and a domain being deleted cannot be transferred. Once it is released, you may be able to register it instead.',
    )
  }
  if (has('redemption period') || has('pending restore')) {
    return fail(
      'It has expired and is in the redemption period. Restore it at your current registrar first — it cannot be transferred until then.',
    )
  }
  if (has('pending transfer')) {
    return fail(
      'A transfer is already in progress. Wait for it to finish, or ask your current registrar to cancel it.',
    )
  }

  if (record.expiresAt && new Date(record.expiresAt) < now) {
    return {
      id: 'status',
      state: 'manual',
      title,
      detail: `It expired on ${formatDate(record.expiresAt)}. Your registrar can refuse a transfer while the renewal is unpaid, so renewing it there first avoids a refusal.`,
      unblocksAt: null,
    }
  }

  return {
    id: 'status',
    state: 'pass',
    title,
    detail: record.expiresAt
      ? `Its registry status allows a transfer. It is paid up until ${formatDate(record.expiresAt)}.`
      : 'Its registry status allows a transfer.',
    unblocksAt: null,
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function evaluateTransfer({
  domain,
  tld,
  offer,
  lookup,
  now,
}: {
  domain: string
  tld: string
  offer: ExtensionOffer
  /** Null when the extension rules the transfer out and no lookup was made. */
  lookup: RdapLookup | null
  now: Date
}): TransferVerdict {
  const extension = extensionCheck(tld, offer)

  if (extension.state === 'fail') {
    return {
      domain,
      tld,
      outcome: 'unsupported-extension',
      checks: [extension],
      opensOn: null,
      registrar: null,
      expiresAt: null,
    }
  }

  if (lookup?.kind === 'not-found') {
    return {
      domain,
      tld,
      outcome: 'not-registered',
      checks: [
        extension,
        {
          id: 'registered',
          state: 'fail',
          title: 'The domain is registered',
          detail: `Nobody has registered ${domain}, so there is nothing to transfer. You can register it instead.`,
          unblocksAt: null,
        },
      ],
      opensOn: null,
      registrar: null,
      expiresAt: null,
    }
  }

  const record = lookup?.kind === 'found' ? lookup.record : null
  const registrar = record?.registrar ?? null

  const registered: TransferCheck = record
    ? {
        id: 'registered',
        state: 'pass',
        title: 'The domain is registered',
        detail: registrar
          ? `It is registered through ${registrar}.`
          : 'The registry has a record of it.',
        unblocksAt: null,
      }
    : {
        id: 'registered',
        state: 'manual',
        title: 'The domain is registered',
        detail:
          lookup?.kind === 'unsupported'
            ? `The .${tld} registry does not publish live records, so we cannot look it up. Your current registrar can confirm it.`
            : 'The registry did not answer just now. Try again in a minute, or confirm with your current registrar.',
        unblocksAt: null,
      }

  const checks: TransferCheck[] = [
    extension,
    registered,
    lockCheck(record, registrar ?? 'your current registrar'),
    windowCheck(record, now),
    statusCheck(record, now),
    AUTH_CODE,
  ]

  const failures = checks.filter((check) => check.state === 'fail')
  const unsure = checks.filter((check) => check.state === 'manual' && check.id !== 'auth-code')

  const outcome: TransferOutcome =
    failures.length > 0 ? 'blocked' : unsure.length > 0 ? 'needs-confirmation' : 'ready'

  // Only when time alone is in the way can we promise a date.
  const opensOn =
    failures.length > 0 && failures.every((check) => check.unblocksAt)
      ? (failures
          .map((check) => check.unblocksAt as string)
          .sort()
          .at(-1) ?? null)
      : null

  return {
    domain,
    tld,
    outcome,
    checks,
    opensOn,
    registrar,
    expiresAt: record?.expiresAt ?? null,
  }
}
