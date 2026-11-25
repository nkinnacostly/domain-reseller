/**
 * The ops copilot's words (migration 74). It explains and drafts; a person
 * decides and acts, and the dialog says so every time (N9b).
 */

/** Alerts whose cause may sit with DomainNameAPI: these offer a draft ticket. */
const TICKET_KINDS = new Set([
  'job_needs_attention',
  'ssl_job_needs_attention',
  'ssl_status_unrecognised',
  'catalogue_sync',
  'reconcile_stale',
  'float_low',
  'float_low_cover',
])

export function offersTicket(kind: string): boolean {
  return TICKET_KINDS.has(kind) || kind.startsWith('supplier_') || kind.startsWith('drift')
}

export const COPILOT = {
  explain: 'Explain',
  ticket: 'Draft supplier ticket',
  title: { explain: 'What this alert means', ticket: 'A ticket for DomainNameAPI' },
  loading: 'Asking the copilot…',
  steps: 'What to check',
  subject: 'Subject',
  body: 'Message',
  copy: 'Copy the ticket',
  copied: 'Copied',
  retry: 'Ask again',
  close: 'Close',
  note: 'Written by an AI model from this alert’s words only — it has not checked anything. Domain names were kept from it and put back here. Check before you act.',
} as const

/** "Explain the alert “Supplier charge with no order”" — each row's buttons named apart. */
export function copilotButtonLabel(mode: 'explain' | 'ticket', kindLabel: string): string {
  return `${mode === 'explain' ? COPILOT.explain : COPILOT.ticket}: ${kindLabel}`
}
