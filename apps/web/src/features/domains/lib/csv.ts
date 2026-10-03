import type { LocalStatus } from '@dr/shared'
import { toCsv } from '@/lib/csv'
import type { PortfolioDomain } from './portfolio'

/**
 * FR-P4 — the portfolio as a CSV file, built in the browser from what the
 * page already shows: nothing is fetched and nothing is logged. Cells are
 * quoted and guarded against formulas by `@/lib/csv`, because a label is
 * the customer's own text.
 */

export const CSV_HEADER = [
  'Domain',
  'Status',
  'Expires',
  'Nameservers',
  'Labels',
  'Auto-renew',
  'Transfer lock',
  'Privacy',
] as const

const onOff = (value: boolean) => (value ? 'On' : 'Off')

/**
 * One row per domain, in the order given. Expiry is a plain date
 * (YYYY-MM-DD, in Lagos) so a spreadsheet sorts it; nameservers are the set
 * the registry holds, space-separated; labels are their names.
 */
export function portfolioCsv(
  domains: readonly Pick<
    PortfolioDomain,
    | 'domainName'
    | 'status'
    | 'expiresAt'
    | 'nameservers'
    | 'labels'
    | 'autoRenew'
    | 'transferLock'
    | 'privacyEnabled'
  >[],
  statusText: (status: LocalStatus) => string,
): string {
  return toCsv([
    CSV_HEADER,
    ...domains.map((domain) => [
      domain.domainName,
      statusText(domain.status),
      domain.expiresAt ? lagosDate(domain.expiresAt) : '',
      (domain.nameservers ?? []).join(' '),
      domain.labels.map((label) => label.name).join('; '),
      onOff(domain.autoRenew),
      onOff(domain.transferLock),
      onOff(domain.privacyEnabled),
    ]),
  ])
}

/** 2026-09-24 — en-CA formats as ISO, and the day is Lagos's. */
const LAGOS_ISO_DATE = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Africa/Lagos',
})

export function lagosDate(value: string | Date): string {
  return LAGOS_ISO_DATE.format(new Date(value))
}

export function csvFileName(now: Date): string {
  return `domains-${lagosDate(now)}.csv`
}
