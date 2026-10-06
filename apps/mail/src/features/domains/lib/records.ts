/**
 * The DNS records a domain needs (MAIL-SPEC §5), from what SES gave it:
 *
 *   three DKIM CNAMEs   <token>._domainkey.<domain> → <token>.dkim.amazonses.com
 *   MAIL FROM MX        send.<domain> → 10 feedback-smtp.<region>.amazonses.com
 *   MAIL FROM SPF       send.<domain> TXT "v=spf1 include:amazonses.com ~all"
 *   DMARC (suggested)   _dmarc.<domain> TXT "v=DMARC1; p=none;"
 *
 * The record names and values are the SES developer guide's (Easy DKIM,
 * custom MAIL FROM). Only the CNAMEs decide verification; the MAIL FROM pair
 * keeps bounces on the customer's own subdomain, and SES falls back to its
 * own domain until it is there (§5.2: BehaviorOnMxFailure USE_DEFAULT_VALUE).
 */

export type RecordPurpose = 'dkim' | 'mail_from_mx' | 'mail_from_spf' | 'dmarc'

export type DnsRecord = {
  id: string
  purpose: RecordPurpose
  type: 'CNAME' | 'MX' | 'TXT'
  /** The full host name. */
  name: string
  /** What to paste into the record's value (an MX's host, without its priority). */
  value: string
  priority?: number
  /** False only for DMARC, which we suggest but do not need. */
  required: boolean
}

export const SPF_VALUE = 'v=spf1 include:amazonses.com ~all'
export const DMARC_VALUE = 'v=DMARC1; p=none;'
export const MX_PRIORITY = 10

export function domainRecords({
  name,
  dkimTokens,
  mailFromDomain,
  region,
}: {
  name: string
  dkimTokens: readonly string[]
  mailFromDomain: string | null
  region: string
}): DnsRecord[] {
  const mailFrom = mailFromDomain ?? `send.${name}`
  return [
    ...dkimTokens.map(
      (token, index): DnsRecord => ({
        id: `dkim-${index + 1}`,
        purpose: 'dkim',
        type: 'CNAME',
        name: `${token}._domainkey.${name}`,
        value: `${token}.dkim.amazonses.com`,
        required: true,
      }),
    ),
    {
      id: 'mail-from-mx',
      purpose: 'mail_from_mx',
      type: 'MX',
      name: mailFrom,
      value: `feedback-smtp.${region}.amazonses.com`,
      priority: MX_PRIORITY,
      required: true,
    },
    {
      id: 'mail-from-spf',
      purpose: 'mail_from_spf',
      type: 'TXT',
      name: mailFrom,
      value: SPF_VALUE,
      required: true,
    },
    {
      id: 'dmarc',
      purpose: 'dmarc',
      type: 'TXT',
      name: `_dmarc.${name}`,
      value: DMARC_VALUE,
      required: false,
    },
  ]
}

/**
 * The record's name as most DNS editors want it: the part before the zone,
 * or `@` for the zone itself (Cloudflare, Hostinger and cPanel all add the
 * zone to what is typed).
 */
export function hostLabel(recordName: string, zone: string): string {
  if (recordName === zone) return '@'
  return recordName.endsWith(`.${zone}`) ? recordName.slice(0, -(zone.length + 1)) : recordName
}
