/**
 * How a state looks: one of five tones, each built from the existing status
 * tokens (S2 — no colour is hard-coded, both themes are covered). A tone only
 * colours; the label carries the meaning.
 */

export type Tone = 'ok' | 'warning' | 'danger' | 'info' | 'neutral'

export const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-status-active/15 border-status-active/30 [--dot:var(--status-active)]',
  warning: 'bg-status-expiring/15 border-status-expiring/30 [--dot:var(--status-expiring)]',
  danger: 'bg-status-redemption/15 border-status-redemption/30 [--dot:var(--status-redemption)]',
  info: 'bg-status-pending/15 border-status-pending/30 [--dot:var(--status-pending)]',
  neutral: 'bg-status-neutral/15 border-status-neutral/30 [--dot:var(--status-neutral)]',
}

const TONES: Record<string, Tone> = {
  // Money and work that is done.
  completed: 'ok',
  succeeded: 'ok',
  sent: 'ok',
  delivered: 'ok',
  matched: 'ok',
  topup: 'ok',
  active: 'ok',
  ok: 'ok',
  paid: 'ok',
  // On its way.
  queued: 'info',
  running: 'info',
  sending: 'info',
  submitted: 'info',
  provisioning: 'info',
  pending: 'info',
  awaiting_payment: 'info',
  intent: 'info',
  // A person should look.
  held: 'warning',
  warning: 'warning',
  partially_failed: 'warning',
  deferred: 'warning',
  unclassified: 'warning',
  refused: 'warning',
  skipped: 'neutral',
  // Something went wrong.
  failed: 'danger',
  needs_attention: 'danger',
  critical: 'danger',
  bounced: 'danger',
  unexplained: 'danger',
  // Over, either way.
  cancelled: 'neutral',
  refunded: 'neutral',
}

export function toneOf(value: string | null | undefined): Tone {
  return (value && TONES[value]) || 'neutral'
}
