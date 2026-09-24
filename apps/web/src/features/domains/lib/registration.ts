import type { LocalStatus } from '@dr/shared'

/**
 * What the panel says about a domain's registration and a waiting
 * nameserver change. Copy describes what the system does (N9b): test
 * payments are registered in the supplier's sandbox (DNA_WRITE_ENV=ote),
 * never the live registry, and demo domains never reach a registry at all.
 */

type Subject = {
  status: LocalStatus
  source: 'registration' | 'transfer' | 'demo'
  testMode: boolean
  failureCode?: string | null
}

export type Note = { title: string; body: string }

/** PRD §13.8, in words for the person who paid. Never the supplier's own text (N10). */
const FAILURE_REASON: Record<string, string> = {
  DOMAIN_TAKEN: 'Someone else registered this name before we could.',
  TLD_UNSUPPORTED: 'The registry would not accept this extension from us.',
  CONTACT_INVALID: 'The registry rejected the contact details.',
  // Renewals (migration 23): the line named a domain this account does not hold.
  NOT_RENEWABLE: 'This domain is not one this account can renew.',
  DOMAIN_NOT_FOUND: 'The registry does not list this domain in our account.',
}
const FAILURE_FALLBACK = 'The registry could not complete it.'

export function failureReason(code: string | null | undefined): string {
  return (code && FAILURE_REASON[code]) || FAILURE_FALLBACK
}

export function registrationNote(domain: Subject): Note | null {
  if (domain.source === 'demo') {
    return domain.status === 'pending'
      ? { title: 'Demo domain.', body: 'It is never registered.' }
      : null
  }
  if (domain.status === 'pending') {
    return domain.testMode
      ? {
          title: 'Registering in the sandbox.',
          body: 'This was a test payment, so it goes to the registrar’s test system, not the live registry. It will not work on the internet.',
        }
      : {
          title: 'Registering.',
          body: 'Your payment is in and the registration is queued. This page shows the result once the registry confirms it.',
        }
  }
  if (domain.status === 'registration_failed') {
    return {
      title: 'Registration failed.',
      body: `${failureReason(domain.failureCode)} ${
        domain.testMode
          ? 'This was a test payment, so no money moved.'
          : 'We’ll refund what you paid for it.'
      }`,
    }
  }
  if (domain.testMode) {
    return {
      title: 'Sandbox registration.',
      body: 'Registered in the registrar’s test system from a test payment. It does not work on the internet.',
    }
  }
  return null
}

export function nameserverNote(
  domain: Subject & { pendingNameservers: string[] | null },
): Note | null {
  const requested = domain.pendingNameservers?.join(', ')
  if (!requested) return null
  if (domain.source === 'demo') {
    return {
      title: 'Demo domain.',
      body: `Requested: ${requested}. Nothing is sent to a registry.`,
    }
  }
  if (domain.status === 'pending') {
    return {
      title: 'Waiting for registration.',
      body: `Applied straight after the domain is registered: ${requested}.`,
    }
  }
  if (domain.status !== 'active') return null
  return { title: 'Sent to the registry.', body: `Waiting to be applied: ${requested}.` }
}
