import { z } from 'zod'
import { type PricingInputs, type Retail, retailFromUsd } from '../pricing/index'
import { contactSchema } from '../schemas/index'

/**
 * SSL certificates (PRD E15, FR-SSL-1 – FR-SSL-9), resold from
 * DomainNameAPI's SSL service (PRD Appendix E, read 2 Oct 2026).
 *
 * Pure: pricing, names, CSRs and the words every surface uses for the term.
 * The supplier calls themselves are the gateway's (N1).
 */

// ── Products and prices ──────────────────────────────────────────────────────

/** One product as `ssl_products` holds it, synced from `GET /products/ssls`. */
export type SslProductRecord = {
  productCode: string
  name: string
  vendor: string
  validationType: string
  isWildcard: boolean
  isMultiDomain: boolean
  /**
   * Names one certificate covers, the main one included. The supplier lists
   * extra names (`maxSanCount`) but no price for them, so we sell only the
   * included ones (N5b).
   */
  includedNames: number
  isReissueFree: boolean
  /** The supplier's price for one term, Reseller group, period 1 — USD. */
  createUsd: number | null
}

export type SslPricing = Omit<SslProductRecord, 'createUsd'> & {
  /** What one certificate costs the customer, and us, in kobo. */
  price: Retail
  createUsd: number
}

/**
 * Priced exactly like a domain (FR-SSL-2): the supplier's USD cost at the
 * effective rate, plus the flat margin, rounded up to ₦100. No ICANN fee —
 * that is a domain registry charge. A product without a cost is left out:
 * withheld, never guessed (N5b).
 */
export function priceSslProducts(
  records: readonly SslProductRecord[],
  inputs: PricingInputs,
): SslPricing[] {
  const out: SslPricing[] = []
  for (const record of records) {
    const price = retailFromUsd(record.createUsd, inputs)
    if (!price || record.createUsd === null) continue
    out.push({ ...record, createUsd: record.createUsd, price })
  }
  return out
}

/**
 * The term, in the words every page, email and receipt uses (N9b). Checked
 * against the supplier on 2 Oct 2026: its record of a purchase runs exactly
 * one year from the purchase, and reissues are listed as free. Since 15 March
 * 2026 a publicly trusted certificate lasts at most 200 days (100 from March
 * 2027), so one certificate never covers the whole year.
 */
export const SSL_TERM = {
  short: '1-year subscription',
  long: 'A one-year subscription with the certificate authority. Certificates now last at most 200 days, so one certificate does not cover the year: reissue it, free, before it expires. We show each certificate’s expiry date once it is issued.',
  renewal: (price: string) =>
    `It never renews by itself: when the subscription ends, buy a new certificate — ${price} at today’s price.`,
} as const

// ── Names ────────────────────────────────────────────────────────────────────

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/**
 * A hostname a certificate can be for: two or more labels, lower case, no
 * wildcard (a wildcard product adds `*.` itself) and no IP address. The
 * supplier accepted "not a domain" as a name in the sandbox and charged for
 * it (2 Oct 2026), so every name is checked here before anything is bought.
 */
export const sslHostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/\.$/, ''))
  .pipe(
    z
      .string()
      .min(4, 'Enter the full name, for example example.com')
      .max(253)
      .refine((value) => !value.startsWith('*.'), 'Leave out the "*." — the wildcard adds it')
      .refine((value) => value.split('.').length >= 2, 'Include the extension, for example .com')
      .refine(
        (value) => value.split('.').every((label) => LABEL.test(label)),
        'Use only letters, numbers, hyphens and dots',
      )
      .refine(
        (value) => !/^\d+$/.test(value.split('.').at(-1) ?? ''),
        'Use a name, not an IP address',
      ),
  )

/**
 * The name every supplier call for this certificate uses. A wildcard is
 * bought, set up and read as `*.example.com` — initialised as the bare name it
 * can never be set up (sandbox, 2 Oct 2026: the CSR must start with `*.`, and
 * the set-up looks the certificate up by the name it was bought under).
 */
export function supplierName(host: string, isWildcard: boolean): string {
  return isWildcard ? `*.${host}` : host
}

/** The name without a leading `*.`: where approval emails go, and what the cart shows as the site. */
export function bareName(name: string): string {
  return name.replace(/^\*\./, '')
}

/** `www.example.com` → `example.com`: the domain extra names must sit under. */
export function namesBase(main: string): string {
  const bare = bareName(main)
  return bare.startsWith('www.') && bare.split('.').length > 2 ? bare.slice(4) : bare
}

/**
 * Extra names on a multi-domain certificate (FR-SSL-5). The supplier takes
 * one approver address for the whole certificate, so every name must be the
 * main name's domain or under it — one approval can cover them. Duplicates
 * and the main name itself are refused, and no more than the product
 * includes: extra names are not priced (N5b).
 */
export function extraNamesProblem(
  main: string,
  extras: readonly string[],
  includedNames: number,
): string | null {
  const base = namesBase(main)
  const seen = new Set<string>([bareName(main)])
  if (extras.length > Math.max(0, includedNames - 1)) {
    return `This certificate covers ${includedNames} names in all, the main one included.`
  }
  for (const raw of extras) {
    const parsed = sslHostnameSchema.safeParse(raw)
    if (!parsed.success) return `${raw}: ${parsed.error.issues[0]?.message ?? 'not a name'}`
    const name = parsed.data
    if (seen.has(name)) return `${name} is listed twice.`
    if (name !== base && !name.endsWith(`.${base}`)) {
      return `${name} is not under ${base}. Every name must be ${base} or end in .${base}, so one approval covers them all.`
    }
    seen.add(name)
  }
  return null
}

// ── CSRs ─────────────────────────────────────────────────────────────────────

const CSR_PEM =
  /^-----BEGIN (NEW )?CERTIFICATE REQUEST-----\n[A-Za-z0-9+/=\n]{100,8000}\n-----END (NEW )?CERTIFICATE REQUEST-----$/

/** True for anything that carries a private key — which must never be pasted, sent or kept. */
export function containsPrivateKey(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
}

export type CsrInput = { ok: true; csr: string } | { ok: false; reason: string }

/**
 * A pasted CSR, tidied (CRLF, spaces) and checked for shape. The CA's own
 * check (`check-csr`) reads what is inside; this only refuses what is plainly
 * not a CSR — and anything carrying a private key, so a key pasted by
 * mistake is neither sent nor stored (N13).
 */
export function readCsr(text: string): CsrInput {
  if (containsPrivateKey(text)) {
    return {
      ok: false,
      reason:
        'That includes a private key. Paste only the certificate request (CSR), and keep the key on your server.',
    }
  }
  const tidy = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
  if (!CSR_PEM.test(tidy)) {
    return {
      ok: false,
      reason:
        'That is not a certificate request. Paste everything from -----BEGIN CERTIFICATE REQUEST----- to -----END CERTIFICATE REQUEST-----.',
    }
  }
  return { ok: true, csr: tidy }
}

// ── Set-up ───────────────────────────────────────────────────────────────────

/**
 * The servers the supplier accepts: it refused nginx, tomcat, cpanel, plesk
 * and "other" in the sandbox (2 Oct 2026) and took only Apache and IIS by
 * name. The certificate we hand over is the same PEM text either way.
 */
export const SSL_WEB_SERVERS = ['apache', 'iis'] as const
export type SslWebServer = (typeof SSL_WEB_SERVERS)[number]

/**
 * The contact the CA records for the certificate. Our contact form, with
 * the supplier's shorter limits (city and state 20 characters, postcode 10)
 * so a long value is caught on the form, not refused after the order.
 */
export const sslContactSchema = contactSchema.extend({
  city: z.string().min(1, 'City is required').max(20, 'Use 20 characters or fewer'),
  state: z.string().min(1, 'State is required').max(20, 'Use 20 characters or fewer'),
  zipCode: z.string().min(1, 'Postal code is required').max(10, 'Use 10 characters or fewer'),
})
export type SslContact = z.infer<typeof sslContactSchema>

/** Where a certificate stands, in our words (`ssl_certificates.status`, migration 39). */
export const SSL_STATUSES = [
  'pending',
  'awaiting_setup',
  'setting_up',
  'awaiting_validation',
  'issued',
  'reissuing',
  'revoked',
  'cancelled',
  'failed',
] as const
export type SslStatus = (typeof SSL_STATUSES)[number]
