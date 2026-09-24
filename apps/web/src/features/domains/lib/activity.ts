import { failureReason } from './registration'

/** One activity line per domain_events row (FR-N5, FR-P6), in words. */

const list = (value: unknown) => (Array.isArray(value) ? value.join(', ') : '')
const yearsText = (value: unknown) => {
  const years = Number(value)
  return Number.isInteger(years) && years > 0
    ? `${years} ${years === 1 ? 'year' : 'years'}`
    : 'a period'
}
const dateFormat = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'Africa/Lagos' })

export function describeEvent(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'order_paid':
      return `Paid for in order ${payload.order_number ?? ''}`.trim()
    case 'registered':
      return payload.sandbox ? 'Registered in the registrar’s test system' : 'Registered'
    case 'registration_failed':
      return `Registration failed: ${failureReason(payload.code as string | undefined)}`
    case 'registration_delayed':
      return 'Registration delayed — waiting on the registry'
    case 'renewal_paid':
      return `Renewal for ${yearsText(payload.years)} paid for in order ${payload.order_number ?? ''}`.trim()
    case 'renewed': {
      const where = payload.sandbox ? ' in the registrar’s test system' : ''
      return typeof payload.to === 'string'
        ? `Renewed for ${yearsText(payload.years)}${where} — now expires ${dateFormat.format(new Date(payload.to))}`
        : `Renewed for ${yearsText(payload.years)}${where}`
    }
    case 'renewal_failed':
      return `Renewal failed: ${failureReason(payload.code as string | undefined)}`
    case 'renewal_delayed':
      return 'Renewal delayed — waiting on the registry'
    case 'transfer_submitted':
      return 'Transfer request sent to the registry — waiting on the current registrar'
    case 'transferred_in': {
      const done = payload.sandbox
        ? 'Transferred into the registrar’s test system'
        : 'Transferred in'
      return typeof payload.expires_at === 'string'
        ? `${done} — expires ${dateFormat.format(new Date(payload.expires_at))}`
        : done
    }
    case 'transfer_failed':
      return `Transfer failed: ${failureReason(payload.code as string | undefined)}`
    case 'transfer_delayed':
      return 'Transfer delayed — waiting on the registry'
    case 'nameservers_requested':
      return `Nameserver change requested: ${list(payload.after)}`
    case 'nameservers_applied':
      return `Nameservers applied at the registry: ${list(payload.nameservers)}`
    case 'nameservers_rejected':
      return `Nameservers refused by the registry: ${list(payload.requested)}`
    case 'nameservers_delayed':
      return 'Nameserver change delayed — waiting on the registry'
    case 'nameservers_not_applied':
      return 'Nameserver change not applied'
    case 'nameservers_synced':
      return `Nameservers updated from the registry: ${list(payload.after)}`
    case 'expiry_updated_from_registry':
      return typeof payload.after === 'string'
        ? `Expiry date updated from the registry: ${dateFormat.format(new Date(payload.after))}`
        : 'Expiry date updated from the registry'
    case 'auto_renew_on':
      return 'Auto-renew turned on'
    case 'auto_renew_off':
      return 'Auto-renew turned off'
    case 'demo_created':
      return 'Added as a demo domain'
    default:
      return describeSettingEvent(type, payload)
  }
}

const onOff = (value: unknown) => (value ? 'on' : 'off')

/**
 * Registry-side settings (migration 26) and transfer-code reveals (FR-DS5).
 * Payloads carry codes and flags only — never contact details or a code.
 */
function describeSettingEvent(type: string, payload: Record<string, unknown>): string {
  const reason = () => failureReason(payload.code as string | undefined)
  switch (type) {
    case 'transfer_lock_requested':
      return `Asked to turn the transfer lock ${onOff(payload.to)}`
    case 'transfer_lock_applied':
      return `Transfer lock turned ${onOff(payload.transfer_lock)} at the registry`
    case 'transfer_lock_rejected':
      return `Transfer lock change refused by the registry: ${reason()}`
    case 'transfer_lock_delayed':
      return 'Transfer lock change delayed — waiting on the registry'
    case 'transfer_lock_not_applied':
      return 'Transfer lock change not applied'
    case 'privacy_requested':
      return `Asked to turn contact privacy ${onOff(payload.to)}`
    case 'privacy_applied':
      return `Contact privacy turned ${onOff(payload.privacy)} at the registry`
    case 'privacy_rejected':
      return `Contact privacy change refused by the registry: ${reason()}`
    case 'privacy_delayed':
      return 'Contact privacy change delayed — waiting on the registry'
    case 'privacy_not_applied':
      return 'Contact privacy change not applied'
    case 'contacts_requested':
      return 'Asked to change the registrant'
    case 'contacts_applied':
      return 'Registrant updated at the registry'
    case 'contacts_rejected':
      return `Registrant change refused by the registry: ${reason()}`
    case 'contacts_delayed':
      return 'Registrant change delayed — waiting on the registry'
    case 'contacts_not_applied':
      return 'Registrant change not applied'
    case 'auth_code_revealed':
      return payload.sandbox
        ? 'Transfer code shown, from the registrar’s test system'
        : 'Transfer code shown'
    default:
      return type.replaceAll('_', ' ')
  }
}
