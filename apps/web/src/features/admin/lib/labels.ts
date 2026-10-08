/**
 * Words for the states the admin pages show (docs/ADMIN-SPEC.md §5.3: words
 * on every pill — colour is never the only signal). An unknown value is
 * shown as itself, with underscores spaced, rather than hidden.
 */

export const REFUND_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  held: 'Held for approval',
  sending: 'Sending',
  submitted: 'With Flutterwave',
  completed: 'Refunded',
  failed: 'Failed',
  needs_attention: 'Needs a person',
  cancelled: 'Cancelled',
}

export const REFUND_REASON_LABEL: Record<string, string> = {
  registration_failed: 'Registration failed',
  renewal_failed: 'Renewal failed',
  transfer_failed: 'Transfer failed',
  ssl_failed: 'Certificate not ordered',
  duplicate_charge: 'Charged twice',
  overpayment: 'Overpaid',
  underpayment: 'Underpaid',
  empty_order: 'Nothing to supply',
  late_payment: 'Paid too late',
  over_limit: 'Over the daily limit',
}

export const JOB_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  needs_attention: 'Needs a person',
}

export const JOB_KIND_LABEL: Record<string, string> = {
  register_domain: 'Registration',
  renew_domain: 'Renewal',
  transfer_domain: 'Transfer in',
  apply_nameservers: 'Nameserver change',
  set_transfer_lock: 'Transfer lock change',
  set_privacy: 'Privacy change',
  update_contacts: 'Contact change',
  ssl_initialize: 'Certificate order',
  ssl_configure: 'Certificate set-up',
  ssl_reissue: 'Certificate reissue',
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  provisioning: 'Provisioning',
  completed: 'Completed',
  partially_failed: 'Partly failed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const LINE_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  provisioning: 'Provisioning',
  completed: 'Completed',
  failed: 'Failed',
  refunded: 'Refunded',
}

export const EMAIL_STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting',
  sending: 'Sending',
  sent: 'Sent',
  skipped: 'Skipped',
  failed: 'Failed',
  delivered: 'Delivered',
  bounced: 'Bounced',
  deferred: 'Deferred',
}

export const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  warning: 'Warning',
}

export const AUDIT_OUTCOME_LABEL: Record<string, string> = {
  intent: 'Asked',
  ok: 'Done',
  refused: 'Refused',
  failed: 'Failed',
}

export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  operator: 'Operator',
  viewer: 'Viewer',
}

export const LEDGER_STATE_LABEL: Record<string, string> = {
  pending: 'Waiting to match',
  matched: 'Matched',
  topup: 'Top-up',
  unexplained: 'No matching order',
  unclassified: 'Not classified',
}

/** The word for a value from one of the maps above; the value itself when unknown. */
export function labelFor(map: Record<string, string>, value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  return map[value] ?? value.replace(/_/g, ' ')
}
