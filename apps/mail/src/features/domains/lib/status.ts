import type { Tone } from '@/components/common/status-pill'
import { SAFETY } from '@/features/marketing/lib/site'
import type { RecordState } from './dns-check'

/**
 * A domain's state in words (MAIL-SPEC §5): what it is, why, and what to do
 * next. Colour is never the only signal — every pill has its name (S8).
 */

export type DomainStatus = 'pending' | 'verified' | 'failed' | 'removing' | 'removed' | 'sandbox'

export type DomainPhase = 'setting_up' | 'pending' | 'verified' | 'failed' | 'removing'

export function domainPhase(status: DomainStatus, settingUp: boolean): DomainPhase | null {
  if (status === 'pending') return settingUp ? 'setting_up' : 'pending'
  if (status === 'verified' || status === 'failed' || status === 'removing') return status
  return null
}

export const PHASE_LABEL: Record<DomainPhase, { label: string; tone: Tone }> = {
  setting_up: { label: 'Setting up', tone: 'info' },
  pending: { label: 'Waiting for DNS', tone: 'warning' },
  verified: { label: 'Verified', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  removing: { label: 'Removing', tone: 'neutral' },
}

export const PHASE_WORDS: Record<DomainPhase, string> = {
  setting_up:
    'We are setting this domain up with Amazon SES. Its DNS records appear here as soon as SES gives them; this usually takes seconds, and we keep trying if SES is slow.',
  pending:
    'Add the records below at your DNS host. We check every 10 minutes for 72 hours; once the three DKIM records are in public DNS and Amazon SES confirms them, the domain is verified.',
  verified: 'Amazon SES has confirmed this domain. You can send from any address at it.',
  failed: 'This domain was not verified in time, so we released it.',
  removing:
    'This domain is being removed from Amazon SES. It disappears from this list in a moment.',
}

const FAILURE_WORDS: Record<string, (missing: string | null) => string> = {
  dkim_record_missing: (missing) =>
    missing
      ? `The DKIM record ${missing} was not found in public DNS within 72 hours.`
      : 'A DKIM record was not found in public DNS within 72 hours.',
  dkim_not_verified: () =>
    'The DKIM records were in public DNS, but Amazon SES did not confirm them within 72 hours.',
  not_set_up: () => 'We could not finish setting the domain up with Amazon SES within 72 hours.',
  ses_refused: () => 'Amazon SES would not accept this domain.',
}

/**
 * Why a domain failed, and what to do about it. A failed claim keeps the name
 * from this account for SAFETY.claimCooldownDays (migration 54), so the next
 * try is then, not at once.
 */
export function failureWords(reason: string | null, missing: string | null): string {
  if (reason === 'ses_identity_exists') {
    return 'Amazon SES already holds this domain outside this account, so we could not add it. If it is yours, email hello@mydomainshub.com and we will sort it out.'
  }
  const said = reason ? FAILURE_WORDS[reason]?.(missing) : undefined
  return `${said ?? 'This domain was not verified in time.'} Check the records at your DNS host. You can try again ${SAFETY.claimCooldownDays} days after it failed, with new DKIM records and another 72 hours.`
}

export const RECORD_STATE_LABEL: Record<RecordState, { label: string; tone: Tone }> = {
  found: { label: 'Found', tone: 'success' },
  spreading: { label: 'Spreading', tone: 'info' },
  different: { label: 'Different value', tone: 'warning' },
  missing: { label: 'Not found yet', tone: 'neutral' },
  unknown: { label: 'Could not check', tone: 'neutral' },
}

export const RECORD_STATE_WORDS: Record<RecordState, string> = {
  found: 'Public DNS has this record.',
  spreading:
    'Some public resolvers have it and some not yet. DNS changes can take a few hours to spread.',
  different: 'This name has a value in public DNS, but not this one.',
  missing: 'Public DNS does not have this record yet.',
  unknown: 'We could not ask public DNS just now. Refresh the page to try again.',
}

const when = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
})

/** A moment for people: Lagos time (§8 "a day"). */
export const formatWhen = (iso: string | null): string | null =>
  iso ? `${when.format(new Date(iso))} (Lagos)` : null
