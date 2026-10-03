import type {
  AuditOutcome,
  AuditPrefix,
  AuditSide,
  AuditWho,
} from '@/features/admin/lib/audit-params'

/**
 * The audit log's words (docs/ADMIN-SPEC.md §5.2, B14). An action is shown in
 * words with its code beside it, so the page reads plainly and still names
 * exactly what SQL recorded. An action this map does not know yet shows as
 * its code — never hidden.
 */

export const AUDIT_TITLE = 'Audit log'

export const AUDIT_DESCRIPTION =
  'Every admin action and refusal, every customer lookup and every live read, newest first. The log is append-only: nothing on this page changes it.'

/** A real admin sees both sides at once; the side switch does not narrow the log. */
export const AUDIT_SIDES_NOTE =
  'Entries from both sides are listed whichever side is chosen; the Side column says which records each one touched.'

/** A test administrator's view (D15, ADMIN-SPEC §2.3). */
export const AUDIT_TEST_ADMIN_NOTE = "Test administrators see test administrators' entries only."

export const AUDIT_READ_FAILED = "The audit log couldn't be read."

export const PREFIX_LABEL: Record<AuditPrefix, string> = {
  refund: 'Refunds',
  incident: 'Incidents',
  job: 'Jobs',
  ssl_job: 'Certificate jobs',
  domain: 'Domains',
  email: 'Emails',
  customer: 'Customers',
  supplier: 'Supplier',
  fx: 'FX',
  pricing: 'Pricing',
  settings: 'Settings',
  extension: 'Extensions',
  ssl_product: 'SSL products',
  preset: 'Presets',
  topup: 'Top-ups',
  audit: 'Audit',
}

export const SIDE_LABEL: Record<AuditSide, string> = {
  live: 'Live',
  test: 'Test',
  global: 'Global',
}

export const WHO_LABEL: Record<AuditWho, string> = {
  admins: 'Administrators',
  test: 'Test administrators',
}

/** The outcome chips' words: the same as the pills (`AUDIT_OUTCOME_LABEL`). */
export const OUTCOME_CHIP: Record<AuditOutcome, string> = {
  intent: 'Asked',
  ok: 'Done',
  refused: 'Refused',
  failed: 'Failed',
}

export const ACTION_LABEL: Record<string, string> = {
  'refund.approve': 'Approve a refund',
  'refund.retry': 'Retry a refund',
  'refund.record_manual': 'Record a Flutterwave refund',
  'refund.cancel': 'Cancel a refund',
  'refund.flw_check': 'Check a refund with Flutterwave',
  'incident.resolve': 'Resolve an incident',
  'incident.resolve_money': 'Resolve an incident where money was owed',
  'job.retry': 'Retry a job',
  'job.fail': 'Fail a job',
  'ssl_job.retry': 'Retry a certificate job',
  'ssl_job.fail': 'Fail a certificate job',
  'email.requeue': 'Send an email again',
  'domain.deep_sync': 'Queue a deep sync',
  'domain.reveal_contacts': "Show a domain's contacts",
  'customer.search': 'Look up a customer',
  'customer.reveal': "Show a customer's contact details",
  'fx.activate': 'Activate an FX rate',
  'fx.reject': 'Reject an FX rate',
  'pricing.update': 'Change pricing inputs',
  'settings.update': 'Change limits',
  'settings.refund_limit_raise': 'Raise a refund limit',
  'extension.flags': "Change an extension's flags",
  'ssl_product.sellable': 'Change whether a certificate is sold',
  'preset.draft_save': 'Save a preset draft',
  'preset.publish': 'Publish a preset draft',
  'preset.show': 'Show a preset',
  'preset.draft_check': 'Check a preset draft in public DNS',
  'preset.draft_discard': 'Discard a preset draft',
  'preset.hide': 'Hide a preset',
  'topup.record': "Record a top-up's cost",
  'topup.correct': "Correct a top-up's cost",
  'audit.redact': 'Remove a reason from the log',
  'supplier.balance': 'Read the live balance',
  'supplier.ledger_live': 'Search the live ledger',
  'supplier.domain_lookup': 'Read a domain at the registry',
  'supplier.domains_page': 'Read a page of registry domains',
  'supplier.verification': "Read a registrant's verification",
  'supplier.ssl_lookup': 'Read a certificate at the supplier',
  'supplier.transfer_query': 'Read a transfer state',
  'supplier.renew_check': 'Check whether a domain renews',
  'supplier.price_check': "Check the supplier's price",
  'supplier.catalogue_preview': 'Preview the extension price list',
  'supplier.ssl_catalogue_preview': 'Preview the SSL price list',
  'supplier.catalogue_apply': 'Apply the extension price list',
  'supplier.ssl_catalogue_apply': 'Apply the SSL price list',
}

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action
}

/** What an entry was about, in words: "Refund", "Job", "Supplier". */
export const TARGET_LABEL: Record<string, string> = {
  refund: 'Refund',
  incident: 'Incident',
  job: 'Job',
  ssl_job: 'Certificate job',
  domain: 'Domain',
  email: 'Email',
  customer: 'Customer',
  customer_search: 'Customer search',
  certificate: 'Certificate',
  supplier: 'Supplier',
  ledger: 'Ledger entry',
  topup: 'Top-up',
  fx_rate: 'FX rate',
  pricing_settings: 'Pricing inputs',
  ops_settings: 'Limits',
  tld: 'Extension',
  ssl_product: 'SSL product',
  preset: 'Preset',
  preset_draft: 'Preset draft',
  flw_refund: 'Flutterwave refund',
  audit: 'Audit entry',
}

export function targetLabel(type: string | null | undefined): string {
  if (!type) return 'Nothing named'
  return TARGET_LABEL[type] ?? type.replace(/_/g, ' ')
}

/**
 * What the gateway did with an intent note (§5.2: "Read: ok", "Refused:
 * TOO_SOON", or "No result recorded"). The mock gateway in e2e records none.
 */
export function gatewayResult(
  result: { outcome: string; errorCode: string | null } | null | undefined,
): string {
  if (!result) return 'No result recorded'
  if (result.outcome === 'ok') return 'Read: ok'
  const word = result.outcome === 'refused' ? 'Refused' : 'Failed'
  return result.errorCode ? `${word}: ${result.errorCode}` : word
}

export const NO_DETAIL = 'Nothing else was recorded.'
export const HIDDEN_VALUE = 'Not shown: personal data'
