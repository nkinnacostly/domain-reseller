import { failureReason } from './registration'

/** One activity line per domain_events row (FR-N5, FR-P6), in words. */

const list = (value: unknown) => (Array.isArray(value) ? value.join(', ') : '')

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
    case 'auto_renew_on':
      return 'Auto-renew turned on'
    case 'auto_renew_off':
      return 'Auto-renew turned off'
    case 'demo_created':
      return 'Added as a demo domain'
    default:
      return type.replaceAll('_', ' ')
  }
}
