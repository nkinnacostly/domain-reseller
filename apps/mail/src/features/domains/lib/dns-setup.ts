import type { Tone } from '@/components/common/status-pill'
import type { CloudflareFailure, RecordOutcome } from './cloudflare'

/**
 * "Add to Cloudflare" in words (MAIL-SPEC §5.3): what happened, why, and what
 * to do next, for each refusal from `mail.start_dns_setup` (migration 57) and
 * each answer from Cloudflare. A code with no words of its own gets the
 * fallback, never the raw code.
 */

export const SETUP_FALLBACK =
  'Something went wrong on our end. Nothing was changed in Cloudflare. Try again, or add the records by hand below.'

const START_WORDS: Record<string, string> = {
  unauthorized: 'Your session has ended. Sign in again to continue.',
  not_found: 'That domain was not found on this account.',
  forbidden:
    'Your role in this account cannot change its DNS. Ask its owner, an admin or a developer.',
  not_ready:
    'This domain’s records are not ready yet. Refresh in a moment, or add it again if it failed.',
  too_many:
    'That is ten tries for this domain in the last hour. Try again later, or add the records by hand below.',
}

export function startRefusal(code: string | undefined): string {
  return (code && START_WORDS[code]) || SETUP_FALLBACK
}

export function cloudflareRefusal(code: CloudflareFailure, zone: string): string {
  switch (code) {
    case 'bad_token':
      return 'Cloudflare did not accept that token. Check you copied all of it, and that it has not expired or been deleted. Nothing was changed.'
    case 'not_allowed':
      return 'That token cannot change DNS records. Create one with the link above: it asks for Zone Read and DNS Edit. Nothing was changed.'
    case 'no_zone':
      return `That token cannot reach ${zone}. When you create it, pick ${zone} (or All zones) under Zone Resources. Nothing was changed.`
    case 'unreachable':
      return 'We could not reach Cloudflare just now. Try again in a minute. Nothing was changed.'
  }
}

export const OUTCOME_LABEL: Record<RecordOutcome, { label: string; tone: Tone }> = {
  added: { label: 'Added', tone: 'success' },
  updated: { label: 'Set to DNS only', tone: 'success' },
  present: { label: 'Already there', tone: 'success' },
  kept_yours: { label: 'Kept yours', tone: 'neutral' },
  conflict: { label: 'Needs you', tone: 'warning' },
  failed: { label: 'Not added', tone: 'danger' },
}

export const OUTCOME_WORDS: Partial<Record<RecordOutcome, string>> = {
  updated:
    'It was there, proxied through Cloudflare (the orange cloud), which hides it from mailboxes. It is DNS only now.',
  kept_yours: 'Your domain already has a DMARC policy, so we left it as it is.',
  conflict:
    'Another record is on this name, so we did not add ours or change yours. Edit it in Cloudflare to match the value below, or ask us.',
  failed: 'Cloudflare did not take this one. Add it by hand below, or try again.',
}

/** After a run that stopped part-way. */
export function stoppedWords(code: CloudflareFailure): string {
  return code === 'unreachable'
    ? 'Cloudflare stopped answering part-way. The records marked “Not added” are not there yet: try again and we skip the ones already added.'
    : 'Cloudflare stopped accepting the token part-way. The records marked “Not added” are not there yet: check the token and try again.'
}
