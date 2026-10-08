import { z } from 'zod'
import { formatNaira, formatRenewal } from '../pricing/index'
import { SSL_TERM } from '../ssl/index'
import { EMAIL_BRAND, type EmailBlock, type EmailContent, renderEmail } from './layout'

/**
 * The notification emails (PRD E12, §16.1). The database queues each with
 * the data it needs (migration 31); the gateway renders it here and sends
 * it. Every template carries a version, recorded on the message it produced
 * (FR-NT4) — change the wording, bump the version.
 *
 * Copy says what happened, what it means, and what to do next — and only
 * what the product does (N9b). A price is never shown without its renewal
 * price (N8). Security notices say they cannot be switched off (FR-NT2).
 */

export type NoticeCategory = 'transactional' | 'security' | 'compliance'

export type NoticeContext = {
  /** Where links point: the site the account belongs to. */
  siteUrl: string
  /** Where MyDomainsHub Mail's notices link to; emails.mydomainshub.com unless a test says otherwise. */
  mailUrl?: string
  /** A test-mode order or domain: no money moved, and the email says so. */
  testMode: boolean
  now: Date
}

export type RenderedNotice = {
  subject: string
  html: string
  text: string
  /** e.g. `order_receipt@1` — recorded with the sent message. */
  version: string
  category: NoticeCategory
  tags: string[]
  /** The sender's display name: the product the email is about. */
  fromName: string
}

// ── Formatting ───────────────────────────────────────────────────────────────

const LAGOS_DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'Africa/Lagos' })
const LAGOS_TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Africa/Lagos',
})

/** "24 September 2026" — a Lagos date: expiry at 23:30 UTC is the next day here. */
export function lagosDate(value: string | Date): string {
  return LAGOS_DATE.format(new Date(value))
}

/** "24 September 2026 at 14:05 (Lagos time)". */
export function lagosDateTime(value: string | Date): string {
  const when = new Date(value)
  return `${LAGOS_DATE.format(when)} at ${LAGOS_TIME.format(when)} (Lagos time)`
}

/** Whole days from `now` until `when`, rounded down; never negative. */
export function daysUntil(when: string | Date, now: Date): number {
  return Math.max(0, Math.floor((new Date(when).getTime() - now.getTime()) / 86_400_000))
}

const years = (count: number) => `${count} ${count === 1 ? 'year' : 'years'}`

/** PRD §13.8, in words for the person who paid. Never the supplier's own text (N10). */
const FAILURE_REASON: Record<string, string> = {
  DOMAIN_TAKEN: 'Someone else registered this name before we could.',
  TLD_UNSUPPORTED: 'The registry would not accept this extension from us.',
  CONTACT_INVALID: 'The registry rejected the contact details.',
  NOT_RENEWABLE: 'This domain is not one this account can renew.',
  DOMAIN_NOT_FOUND: 'The registry does not list this domain in our account.',
  AUTH_CODE_INVALID: 'The current registrar did not accept the transfer code.',
  AUTH_CODE_MISSING: 'We no longer held the transfer code, so the request was never sent.',
  TRANSFER_LOCKED: 'The domain is locked at its current registrar.',
  NOT_TRANSFERABLE: 'The registry would not let this domain transfer.',
  TRANSFER_REJECTED: 'The transfer was refused or cancelled before it completed.',
  ALREADY_HERE: 'This domain is already registered with us on another account.',
  // Set by an administrator's Fail, after a fresh registry read (docs/ADMIN-SPEC.md §3.1.2).
  NOT_AT_REGISTRY: 'The registry did not register it, so nothing was bought.',
  TRANSFER_REFUSED: 'The registry refused the transfer, so the domain did not move to us.',
  STOPPED_BY_ADMIN: 'We stopped this change. Your domain keeps the settings the registry shows.',
}
const FAILURE_FALLBACK = 'The registry could not complete it.'

export function failureReason(code: string | null | undefined): string {
  return (code && FAILURE_REASON[code]) || FAILURE_FALLBACK
}

/** FR-SSL-3: why a certificate could not be ordered, in our words (N10). */
const CERTIFICATE_FAILURE: Record<string, string> = {
  NAME_HAS_CERTIFICATE:
    'Our certificate supplier already holds a certificate for this name, so a second one could not be ordered.',
  SUPPLIER_INSUFFICIENT_FUNDS: 'Our account with the certificate supplier could not cover it.',
  NAME_INVALID: 'The certificate supplier did not accept the name.',
  // An administrator's Fail on an order that was never sent (docs/ADMIN-SPEC.md §3.1.2).
  FAILED_BY_ADMIN: 'The certificate was not ordered, so nothing was bought.',
}

export function certificateFailureReason(code: string | null | undefined): string {
  return (code && CERTIFICATE_FAILURE[code]) || 'Our certificate supplier would not take the order.'
}

// ── Shared pieces ────────────────────────────────────────────────────────────

/** An absolute link on the site; `path` starts with `/`. */
const link = (context: NoticeContext, path: string) =>
  `${context.siteUrl.replace(/\/+$/, '')}${path}`
const domainPath = (domain: string, tab = '') =>
  `/app/domains/${encodeURIComponent(domain)}${tab ? `/${tab}` : ''}`
const certificatePath = (id: string) => `/app/ssl/${encodeURIComponent(id)}`

const SECURITY_FOOTER =
  'This is a security notice. We send one for every sign-in from a new device and every change to your password, two-factor authentication, or a domain’s nameservers, transfer lock or contacts — so they cannot be switched off.'

const NOT_YOU =
  'If you did not do this, change your password now, sign out the devices you do not recognise in your settings, and reply to this email so we can help.'

const TEST_NOTE = 'Test mode: this was paid with Flutterwave test keys, so no money moved.'

// ── MyDomainsHub Mail's pieces ───────────────────────────────────────────────

export const MAIL_PRODUCT = 'MyDomainsHub Mail'
export const MAIL_SITE_URL = 'https://emails.mydomainshub.com'

const mailLink = (context: NoticeContext, path: string) =>
  `${(context.mailUrl ?? MAIL_SITE_URL).replace(/\/+$/, '')}${path}`

const COUNT = new Intl.NumberFormat('en-NG')

/** Parts per million as a percentage, as mail.ppm_text words it: 43,000 → 4.3%, 523 → 0.052%. */
export function percent(ppm: number): string {
  return `${(ppm / 10_000).toFixed(3).replace(/\.?0+$/, '')}%`
}

const MAIL_ROLE: Record<'admin' | 'developer' | 'viewer', string> = {
  admin: 'an admin',
  developer: 'a developer',
  viewer: 'a viewer',
}

/** At most `max` characters, with an ellipsis when cut: an account's name is the customer's text. */
const shorten = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`

const membersFooter = (account: string) =>
  `You get this as an owner or admin of ${account} on MyDomainsHub Mail. It is about the account itself, so it cannot be switched off.`
const ownerFooter = (account: string) =>
  `You get this as the owner of ${account} on MyDomainsHub Mail. It is about the account itself, so it cannot be switched off.`

// ── Templates ────────────────────────────────────────────────────────────────

const iso = z.string().min(1)
const naira = z.coerce.number().int().nonnegative()
const domain = z.string().min(1).max(253)

type Template<S extends z.ZodType> = {
  version: number
  category: NoticeCategory
  schema: S
  subject: (data: z.infer<S>, context: NoticeContext) => string
  content: (data: z.infer<S>, context: NoticeContext) => EmailContent
}

const template = <S extends z.ZodType>(t: Template<S>) => t

const LINE_LABEL: Record<string, string> = {
  register: 'Registration',
  renew: 'Renewal',
  transfer: 'Transfer',
  ssl: 'SSL certificate',
}

/**
 * One receipt line's detail, renewal included (N8). A certificate never
 * renews itself: its "renewal" is buying a new one, at the price on the line.
 */
function receiptDetail(line: {
  kind: string
  years: number
  product?: string | null | undefined
  renewal_kobo: number
  renewal_years: number
}): string {
  if (line.kind === 'ssl') {
    return `${line.product ?? LINE_LABEL.ssl}, ${SSL_TERM.short} · a new one is ${formatNaira(line.renewal_kobo)} at today’s price`
  }
  return `${LINE_LABEL[line.kind] ?? 'Domain'}, ${years(line.years)} · renews at ${formatRenewal(line.renewal_kobo, line.renewal_years)}`
}

const REFUND_REASON: Record<string, (domainName: string | null) => string> = {
  registration_failed: (d) => `because ${d ?? 'a domain'} could not be registered`,
  renewal_failed: (d) => `because ${d ?? 'a domain'} could not be renewed`,
  transfer_failed: (d) => `because the transfer of ${d ?? 'a domain'} did not complete`,
  ssl_failed: (d) => `because the SSL certificate for ${d ?? 'your site'} could not be ordered`,
  duplicate_charge: () => 'because you were charged twice for this order',
  overpayment: () => 'for the amount you paid over the order total',
  underpayment: () => 'for a payment that was less than the order total, which paid for nothing',
  empty_order: () => 'for a payment for an order with nothing in it',
}

export const NOTICE_TEMPLATES = {
  order_receipt: template({
    // 2: a renewal sold only in blocks reads "every 2 years", not "/yr" (migration 37).
    // 3: SSL certificate lines, with the price of a new one beside them (FR-SSL-6, N8).
    version: 3,
    category: 'transactional',
    schema: z.object({
      order_id: z.string().min(1),
      order_number: z.string().min(1),
      invoice_number: z.string().min(1),
      paid_at: iso,
      subtotal_kobo: naira,
      vat_pct: z.coerce.number().nonnegative(),
      vat_kobo: naira,
      total_kobo: naira,
      lines: z
        .array(
          z.object({
            domain,
            kind: z.string(),
            years: z.coerce.number().int().positive(),
            price_kobo: naira,
            /** One year's renewal price. */
            renewal_kobo: naira,
            /** The shortest renewal the extension sells; absent before migration 37. */
            renewal_years: z.coerce.number().int().min(1).max(10).default(1),
            /** An SSL line's product name (migration 39). */
            product: z.string().max(200).nullish(),
          }),
        )
        .min(1),
    }),
    subject: (d) => `Receipt for order ${d.order_number}`,
    content: (d, context) => ({
      heading: 'Thank you — your payment is in',
      blocks: [
        ...(context.testMode ? [{ kind: 'note', text: TEST_NOTE } as const] : []),
        {
          kind: 'text',
          text: `We received ${formatNaira(d.total_kobo)} for order ${d.order_number} on ${lagosDate(d.paid_at)}. We are working on it now and will email you as each ${d.lines.every((line) => line.kind === 'ssl') ? 'certificate' : d.lines.some((line) => line.kind === 'ssl') ? 'item' : 'domain'} is done.`,
        },
        {
          kind: 'rows',
          rows: [
            ...d.lines.map((line) => ({
              label: line.domain,
              // N8 — every line carries its renewal price.
              detail: receiptDetail(line),
              value: formatNaira(line.price_kobo),
            })),
            { label: 'Subtotal', value: formatNaira(d.subtotal_kobo) },
            { label: `VAT (${d.vat_pct}%)`, value: formatNaira(d.vat_kobo) },
            { label: 'Total', value: formatNaira(d.total_kobo), strong: true },
          ],
        },
        { kind: 'text', text: `Invoice number: ${d.invoice_number}` },
      ],
      action: {
        label: 'View your receipt',
        href: link(context, `/app/orders/${d.order_id}/receipt`),
      },
      footer: [
        'Flutterwave’s processing fee, added on its payment page, is not part of this total.',
      ],
    }),
  }),

  domain_registered: template({
    version: 1,
    category: 'transactional',
    schema: z.object({ domain, expires_at: iso.nullish() }),
    subject: (d) => `${d.domain} is registered`,
    content: (d, context) => ({
      heading: `${d.domain} is yours`,
      blocks: [
        {
          kind: 'text',
          text: d.expires_at
            ? `It is registered to you until ${lagosDate(d.expires_at)}.`
            : 'It is registered to you.',
        },
        {
          kind: 'text',
          text: 'Next, point it at the company that hosts your website or email: pick your host from our list and we fill in the nameservers for you, or paste the two your host gave you.',
        },
      ],
      action: {
        label: 'Point your domain',
        href: link(context, domainPath(d.domain, 'nameservers')),
      },
      footer: [
        'It does not renew by itself. We email you a month and a week before it expires, and you can renew any time from your account.',
      ],
    }),
  }),

  domain_renewed: template({
    version: 1,
    category: 'transactional',
    schema: z.object({ domain, years: z.coerce.number().int().positive(), expires_at: iso }),
    subject: (d) => `${d.domain} is renewed`,
    content: (d, context) => ({
      heading: `${d.domain} is renewed`,
      blocks: [
        {
          kind: 'text',
          text: `We renewed ${d.domain} for ${years(d.years)}. It now expires on ${lagosDate(d.expires_at)}.`,
        },
      ],
      action: { label: 'View the domain', href: link(context, domainPath(d.domain)) },
    }),
  }),

  transfer_started: template({
    version: 1,
    category: 'transactional',
    schema: z.object({ domain }),
    subject: (d) => `The transfer of ${d.domain} has started`,
    content: (d, context) => ({
      heading: `Moving ${d.domain} to us`,
      blocks: [
        {
          kind: 'text',
          text: `We have sent the transfer request for ${d.domain} to the registry. Your current registrar may email you to confirm it — approving that can speed things up.`,
        },
        {
          kind: 'text',
          text: 'Transfers usually take up to five days. We will email you when it arrives.',
        },
      ],
      action: { label: 'Follow the transfer', href: link(context, '/app/transfers') },
    }),
  }),

  transfer_completed: template({
    version: 1,
    category: 'transactional',
    schema: z.object({ domain, expires_at: iso.nullish() }),
    subject: (d) => `${d.domain} has moved to ${EMAIL_BRAND.name}`,
    content: (d, context) => ({
      heading: `${d.domain} is here`,
      blocks: [
        {
          kind: 'text',
          text: `The transfer is complete: ${d.domain} is now in your account${d.expires_at ? `, registered until ${lagosDate(d.expires_at)}` : ''}.`,
        },
      ],
      action: { label: 'View the domain', href: link(context, domainPath(d.domain)) },
    }),
  }),

  // FR-SSL-4: bought from the CA; the customer's turn to set it up.
  ssl_ready: template({
    version: 1,
    category: 'transactional',
    schema: z.object({
      certificate_id: z.string().min(1),
      name: domain,
      product: z.string().min(1).max(200),
    }),
    subject: (d) => `Set up your SSL certificate for ${d.name}`,
    content: (d, context) => ({
      heading: `Your certificate for ${d.name} is ordered`,
      blocks: [
        {
          kind: 'text',
          text: `We ordered your ${d.product} from the certificate authority. Before it can be issued, it needs a certificate request (CSR) — paste one from your server, or let us make one — and the address that approves it.`,
        },
        {
          kind: 'text',
          text: 'The certificate authority then emails that address to confirm you control the domain. Once approved, you download the certificate and install it on your server or hosting.',
        },
      ],
      action: {
        label: 'Set up the certificate',
        href: link(context, certificatePath(d.certificate_id)),
      },
      footer: [SSL_TERM.long],
    }),
  }),

  // FR-SSL-7: issued by the CA; ready to download.
  ssl_issued: template({
    version: 1,
    category: 'transactional',
    schema: z.object({
      certificate_id: z.string().min(1),
      name: domain,
      expires_at: iso.nullish(),
    }),
    subject: (d) => `Your SSL certificate for ${d.name} is issued`,
    content: (d, context) => ({
      heading: `${d.name} has its certificate`,
      blocks: [
        {
          kind: 'text',
          text: d.expires_at
            ? `The certificate authority issued your certificate. It expires on ${lagosDate(d.expires_at)}.`
            : 'The certificate authority issued your certificate.',
        },
        {
          kind: 'text',
          text: 'Download it, with its chain, and install it on your server or hosting with the private key you made the request with. Visitors see it only once it is installed.',
        },
      ],
      action: {
        label: 'Download the certificate',
        href: link(context, certificatePath(d.certificate_id)),
      },
      footer: [
        'Before it expires, reissue it from the same page — reissues are free while your subscription lasts. We do not install certificates for you.',
      ],
    }),
  }),

  order_line_failed: template({
    // 2: a certificate that could not be ordered (FR-SSL-3).
    version: 2,
    category: 'transactional',
    schema: z.object({
      domain,
      action: z.enum(['registration', 'renewal', 'transfer', 'certificate']),
      code: z.string().nullish(),
    }),
    subject: (d) =>
      d.action === 'registration'
        ? `We could not register ${d.domain}`
        : d.action === 'renewal'
          ? `We could not renew ${d.domain}`
          : d.action === 'certificate'
            ? `We could not order the SSL certificate for ${d.domain}`
            : `The transfer of ${d.domain} did not complete`,
    content: (d, context) => ({
      heading:
        d.action === 'registration'
          ? `${d.domain} was not registered`
          : d.action === 'renewal'
            ? `${d.domain} was not renewed`
            : d.action === 'certificate'
              ? `No certificate for ${d.domain}`
              : `${d.domain} was not transferred`,
      blocks: [
        {
          kind: 'text',
          text:
            d.action === 'certificate' ? certificateFailureReason(d.code) : failureReason(d.code),
        },
        {
          kind: 'text',
          text: 'You get back what you paid for it, VAT included. The refund goes to the card or account you paid with, automatically, and we will email you when it is sent.',
        },
      ],
      action: { label: 'View your orders', href: link(context, '/app/orders') },
    }),
  }),

  refund_sent: template({
    // 2: a refund for a certificate that could not be ordered (FR-SSL-3).
    version: 2,
    category: 'transactional',
    schema: z.object({
      order_id: z.string().min(1),
      order_number: z.string().min(1),
      amount_kobo: naira,
      reason: z.string(),
      domain: domain.nullish(),
    }),
    subject: (d) => `Your refund of ${formatNaira(d.amount_kobo)} is on its way`,
    content: (d, context) => ({
      heading: 'Your refund is on its way',
      blocks: [
        ...(context.testMode ? [{ kind: 'note', text: TEST_NOTE } as const] : []),
        {
          kind: 'text',
          text: `We have sent ${formatNaira(d.amount_kobo)} back to the card or account you paid with for order ${d.order_number}, ${(REFUND_REASON[d.reason] ?? (() => 'as agreed'))(d.domain ?? null)}.`,
        },
        {
          kind: 'text',
          text: 'Card refunds can take up to 15 business days to show; bank refunds are usually quicker. Flutterwave’s processing fee is not part of the refund.',
        },
      ],
      action: { label: 'View the order', href: link(context, `/app/orders/${d.order_id}`) },
    }),
  }),

  nameservers_changed: template({
    version: 1,
    category: 'security',
    schema: z.object({ domain, nameservers: z.array(z.string()).min(1), at: iso }),
    subject: (d) => `Nameservers changed for ${d.domain}`,
    content: (d, context) => ({
      heading: `${d.domain} points somewhere new`,
      blocks: [
        {
          kind: 'text',
          text: `On ${lagosDateTime(d.at)} the registry changed ${d.domain}’s nameservers to:`,
        },
        { kind: 'list', items: d.nameservers },
        { kind: 'note', text: NOT_YOU },
      ],
      action: {
        label: 'Review the domain',
        href: link(context, domainPath(d.domain, 'nameservers')),
      },
      footer: [SECURITY_FOOTER],
    }),
  }),

  transfer_lock_changed: template({
    version: 1,
    category: 'security',
    schema: z.object({ domain, locked: z.boolean(), at: iso }),
    subject: (d) =>
      d.locked
        ? `Transfer lock turned on for ${d.domain}`
        : `Transfer lock turned off for ${d.domain}`,
    content: (d, context) => ({
      heading: d.locked ? `${d.domain} is locked` : `${d.domain} is unlocked`,
      blocks: [
        {
          kind: 'text',
          text: d.locked
            ? `On ${lagosDateTime(d.at)} the transfer lock was turned on: ${d.domain} cannot be moved to another registrar until you unlock it.`
            : `On ${lagosDateTime(d.at)} the transfer lock was turned off: ${d.domain} can now be moved to another registrar by anyone with its transfer code.`,
        },
        ...(d.locked
          ? []
          : [{ kind: 'note', text: `${NOT_YOU} Turn the lock back on first.` } as const]),
      ],
      action: { label: 'Review security', href: link(context, domainPath(d.domain, 'security')) },
      footer: [SECURITY_FOOTER],
    }),
  }),

  contacts_changed: template({
    version: 1,
    category: 'security',
    schema: z.object({ domain, at: iso }),
    subject: (d) => `Contact details changed for ${d.domain}`,
    content: (d, context) => ({
      heading: `New contact details for ${d.domain}`,
      blocks: [
        {
          kind: 'text',
          text: `On ${lagosDateTime(d.at)} the registry accepted new owner or contact details for ${d.domain}.`,
        },
        { kind: 'note', text: NOT_YOU },
      ],
      action: { label: 'Review contacts', href: link(context, domainPath(d.domain, 'contacts')) },
      footer: [SECURITY_FOOTER],
    }),
  }),

  auth_code_revealed: template({
    version: 1,
    category: 'security',
    schema: z.object({ domain, at: iso }),
    subject: (d) => `Transfer code viewed for ${d.domain}`,
    content: (d, context) => ({
      heading: `The transfer code for ${d.domain} was shown`,
      blocks: [
        {
          kind: 'text',
          text: `On ${lagosDateTime(d.at)} someone signed in to your account viewed the transfer code for ${d.domain}. With it — and the transfer lock off — the domain can be moved to another registrar.`,
        },
        { kind: 'note', text: `${NOT_YOU} Keep the transfer lock on.` },
      ],
      action: { label: 'Review security', href: link(context, domainPath(d.domain, 'security')) },
      footer: [SECURITY_FOOTER],
    }),
  }),

  new_sign_in: template({
    version: 1,
    category: 'security',
    schema: z.object({ device: z.string().min(1).max(80), at: iso }),
    subject: () => 'New sign-in to your account',
    content: (d, context) => ({
      heading: 'A new device signed in',
      blocks: [
        {
          kind: 'text',
          text: `Your account was signed in from ${d.device} on ${lagosDateTime(d.at)}. If that was you, there is nothing to do.`,
        },
        { kind: 'note', text: NOT_YOU },
      ],
      action: { label: 'Review your devices', href: link(context, '/app/settings#sessions') },
      footer: [SECURITY_FOOTER],
    }),
  }),

  password_changed: template({
    version: 1,
    category: 'security',
    schema: z.object({ at: iso }),
    subject: () => 'Your password was changed',
    content: (d, context) => ({
      heading: 'Your password was changed',
      blocks: [
        {
          kind: 'text',
          text: `The password for your ${EMAIL_BRAND.name} account was changed on ${lagosDateTime(d.at)}.`,
        },
        {
          kind: 'note',
          text: 'If you did not change it, reset it now from the sign-in page and reply to this email so we can help.',
        },
      ],
      action: { label: 'Reset your password', href: link(context, '/forgot-password') },
      footer: [SECURITY_FOOTER],
    }),
  }),

  two_factor_on: template({
    version: 1,
    category: 'security',
    schema: z.object({ at: iso }),
    subject: () => 'Two-factor authentication is on',
    content: (d, context) => ({
      heading: 'Two-factor authentication is on',
      blocks: [
        {
          kind: 'text',
          text: `Two-factor authentication was turned on for your account on ${lagosDateTime(d.at)}. From now on, signing in asks for a code from your authenticator app.`,
        },
        { kind: 'note', text: NOT_YOU },
      ],
      action: { label: 'Open your settings', href: link(context, '/app/settings#two-factor') },
      footer: [SECURITY_FOOTER],
    }),
  }),

  two_factor_off: template({
    version: 1,
    category: 'security',
    schema: z.object({ at: iso }),
    subject: () => 'Two-factor authentication was turned off',
    content: (d, context) => ({
      heading: 'Two-factor authentication is off',
      blocks: [
        {
          kind: 'text',
          text: `Two-factor authentication was turned off for your account on ${lagosDateTime(d.at)}. Your password alone now protects it.`,
        },
        { kind: 'note', text: `${NOT_YOU} Then turn two-factor authentication back on.` },
      ],
      action: { label: 'Open your settings', href: link(context, '/app/settings#two-factor') },
      footer: [SECURITY_FOOTER],
    }),
  }),

  // §7.4 ERRP — compliance notices. The post-expiry one must say how to restore.
  expiry_notice: template({
    version: 1,
    category: 'compliance',
    schema: z.object({
      domain,
      expires_at: iso,
      notice: z.enum(['errp_pre_35', 'errp_pre_7', 'errp_post']),
    }),
    subject: (d, context) => {
      if (d.notice === 'errp_post') return `${d.domain} has expired`
      const days = daysUntil(d.expires_at, context.now)
      return `${d.domain} expires in ${days} ${days === 1 ? 'day' : 'days'}`
    },
    content: (d, context) => {
      const renew = {
        label: `Renew ${d.domain}`,
        href: link(context, domainPath(d.domain, 'renew')),
      }
      const why =
        'This is a required renewal reminder. We send one about a month and one about a week before a domain expires, and one just after — they cannot be switched off.'
      if (d.notice === 'errp_post') {
        return {
          heading: `${d.domain} has expired`,
          blocks: [
            {
              kind: 'text',
              text: `${d.domain} expired on ${lagosDate(d.expires_at)}. A website or email that uses it may already have stopped working.`,
            },
            {
              kind: 'text',
              text: 'Most extensions give you a grace period after expiry — often 30 days — when you can still renew at the normal price from your account.',
            },
            {
              kind: 'text',
              text: 'After that, the domain enters redemption: it can be restored only by paying the registry’s restore fee as well as the renewal. To restore a domain in redemption, reply to this email and we will quote you the fee.',
            },
          ] satisfies EmailBlock[],
          action: renew,
          footer: [why],
        }
      }
      const days = daysUntil(d.expires_at, context.now)
      return {
        heading: `${d.domain} expires in ${days} ${days === 1 ? 'day' : 'days'}`,
        blocks: [
          {
            kind: 'text',
            text: `Your domain ${d.domain} expires on ${lagosDate(d.expires_at)}. It does not renew by itself: renew it before then to keep it, and the website and email that use it.`,
          },
          {
            kind: 'text',
            text: 'Renewing adds years to the current expiry date, at the renewal price shown in your account.',
          },
        ],
        action: renew,
        footer: [why],
      }
    },
  }),

  // FR-D8 — once, three days after registration: help, not dunning.
  undelegated_nudge: template({
    version: 1,
    category: 'transactional',
    schema: z.object({ domain }),
    subject: (d) => `${d.domain} is not pointing anywhere yet`,
    content: (d, context) => ({
      heading: `Put ${d.domain} to work`,
      blocks: [
        {
          kind: 'text',
          text: `You registered ${d.domain} a few days ago, but it is not connected to a website or email host yet, so it does not show anything.`,
        },
        {
          kind: 'text',
          text: 'Pick your host from our list and we fill in the nameservers for you, or paste the two your host gave you. We then check that the change took effect.',
        },
      ],
      action: {
        label: `Point ${d.domain}`,
        href: link(context, domainPath(d.domain, 'nameservers')),
      },
      footer: ['We send this once. Not ready yet? You can do it any time from your account.'],
    }),
  }),

  // ── MyDomainsHub Mail (docs/MAIL-SPEC.md §15; migration 58) ─────────────────
  // Queued by Mail's database into this outbox and sent from the shop's own
  // identity — never through Mail's sending path, so a paused account still
  // hears that it is paused. Each names the product and links to Mail.

  mail_invite: template({
    // 2: the subject names no account, and the inviter is their confirmed
    // address — no free text an inviter writes reaches the subject (security
    // audit, 8 Oct 2026; migration 60).
    version: 2,
    category: 'transactional',
    schema: z.object({
      accountName: z.string().min(1).max(100),
      invitedBy: z.string().min(3).max(320),
      role: z.enum(['admin', 'developer', 'viewer']),
      expiresAt: iso,
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    }),
    subject: (d) => `${d.invitedBy} invited you to a team on MyDomainsHub Mail`,
    content: (d, context) => ({
      product: MAIL_PRODUCT,
      heading: 'You’re invited to MyDomainsHub Mail',
      blocks: [
        {
          kind: 'text',
          text: `${d.invitedBy} invited you to join their team, “${shorten(d.accountName, 60)}”, as ${MAIL_ROLE[d.role]}. MyDomainsHub Mail sends an app’s email — receipts, sign-in codes and the like — through one API.`,
        },
        {
          kind: 'text',
          text: `The link works once, and only for this email address, until ${lagosDateTime(d.expiresAt)}. Sign in with this address, or create a MyDomainsHub sign-in with it, to accept.`,
        },
      ],
      action: {
        label: 'Accept the invite',
        href: mailLink(context, `/invite?token=${encodeURIComponent(d.token)}`),
      },
      footer: [
        `Don’t know ${d.invitedBy}, or not expecting this? Ignore it: nothing happens unless you accept, and the invite expires by itself.`,
      ],
    }),
  }),

  mail_cap_reached: template({
    version: 1,
    category: 'transactional',
    schema: z.object({
      accountName: z.string().min(1).max(100),
      scope: z.enum(['day', 'month']),
      level: z.coerce.number().pipe(z.union([z.literal(80), z.literal(100)])),
      cap: z.coerce.number().int().positive(),
      used: z.coerce.number().int().nonnegative(),
      plan: z.string().min(1).max(40).nullish(),
    }),
    subject: (d) =>
      d.level === 100
        ? `${d.accountName} has reached its ${d.scope === 'day' ? 'daily' : 'monthly'} sending limit`
        : `${d.accountName} has used 80% of its ${d.scope === 'day' ? 'daily' : 'monthly'} sending limit`,
    content: (d, context) => {
      const limit = `${COUNT.format(d.cap)} emails a ${d.scope}`
      const resets =
        d.scope === 'day' ? 'at midnight, Lagos time' : 'on the first day of next month, Lagos time'
      return {
        product: MAIL_PRODUCT,
        heading:
          d.level === 100
            ? 'You have reached your sending limit'
            : 'You have used 80% of your sending limit',
        blocks: [
          {
            kind: 'text',
            text:
              d.level === 100
                ? `${d.accountName} has sent ${COUNT.format(d.used)} of its ${limit}${d.plan ? ` on the ${d.plan} plan` : ''}. Until the limit resets ${resets}, the API refuses new emails with a quota_exceeded error.`
                : `${d.accountName} has sent ${COUNT.format(d.used)} of its ${limit}${d.plan ? ` on the ${d.plan} plan` : ''}. At the limit, the API refuses new emails until it resets ${resets}.`,
          },
          {
            kind: 'text',
            text: 'Need more? A bigger plan raises both limits at once.',
          },
        ],
        action: { label: 'See plans', href: mailLink(context, '/dashboard/billing') },
        footer: [membersFooter(d.accountName)],
      }
    },
  }),

  mail_past_due: template({
    version: 1,
    category: 'transactional',
    schema: z.object({
      accountName: z.string().min(1).max(100),
      plan: z.string().min(1).max(40),
      amountKobo: naira.nullish(),
      pastDueUntil: iso.nullish(),
    }),
    subject: (d) => `${d.accountName}: the ${d.plan} plan’s renewal payment has not come through`,
    content: (d, context) => ({
      product: MAIL_PRODUCT,
      heading: 'Your renewal payment has not come through',
      blocks: [
        {
          kind: 'text',
          text: `We have not received this month’s payment for ${d.accountName}’s ${d.plan} plan${d.amountKobo ? ` (${formatNaira(d.amountKobo)}, VAT included)` : ''}.`,
        },
        {
          kind: 'text',
          text: d.pastDueUntil
            ? `Sending carries on until ${lagosDate(d.pastDueUntil)}. Pay on the Billing page before then to keep the ${d.plan} plan; after that the account moves to the Free plan’s limits.`
            : `Pay on the Billing page to keep the ${d.plan} plan; otherwise the account moves to the Free plan’s limits.`,
        },
      ],
      action: { label: 'Pay now', href: mailLink(context, '/dashboard/billing') },
      footer: [ownerFooter(d.accountName)],
    }),
  }),

  mail_plan_lapsed: template({
    version: 1,
    category: 'transactional',
    schema: z.object({
      accountName: z.string().min(1).max(100),
      plan: z.string().min(1).max(40).nullish(),
    }),
    subject: (d) => `${d.accountName} is on the Free plan now`,
    content: (d, context) => ({
      product: MAIL_PRODUCT,
      heading: `${d.accountName} is on the Free plan now`,
      blocks: [
        {
          kind: 'text',
          text: `The ${d.plan ? `${d.plan} plan’s` : 'plan’s'} renewal payment did not come through in time, so ${d.accountName} has moved to the Free plan and its lower limits. Your domains, keys and email log are kept.`,
        },
        {
          kind: 'text',
          text: 'You can choose a paid plan again at any time; it starts as soon as the payment goes through.',
        },
      ],
      action: { label: 'Choose a plan', href: mailLink(context, '/dashboard/billing') },
      footer: [ownerFooter(d.accountName)],
    }),
  }),

  mail_webhook_disabled: template({
    version: 1,
    category: 'transactional',
    schema: z.object({
      accountName: z.string().min(1).max(100),
      endpoint: z.string().min(1).max(253).nullish(),
      failingSince: iso.nullish(),
    }),
    subject: (d) => `${d.accountName}: we turned off a webhook endpoint that kept failing`,
    content: (d, context) => ({
      product: MAIL_PRODUCT,
      heading: 'We turned off a failing webhook endpoint',
      blocks: [
        {
          kind: 'text',
          text: `Your endpoint${d.endpoint ? ` at ${d.endpoint}` : ''} has not accepted our deliveries${d.failingSince ? ` since ${lagosDateTime(d.failingSince)}` : ' for days'}, so we turned it off. Deliveries that were waiting for it were marked failed.`,
        },
        {
          kind: 'text',
          text: 'Your emails were not affected, and every event is still in the email log. Fix the endpoint, then turn it back on from the Webhooks page.',
        },
      ],
      action: { label: 'Open Webhooks', href: mailLink(context, '/dashboard/webhooks') },
      footer: [membersFooter(d.accountName)],
    }),
  }),

  mail_account_paused: template({
    version: 1,
    category: 'transactional',
    schema: z.object({
      accountName: z.string().min(1).max(100),
      reason: z.enum(['bounce_rate', 'complaint_rate', 'ses', 'admin']).nullish(),
      bouncePpm: z.coerce.number().int().nonnegative().nullish(),
      complaintPpm: z.coerce.number().int().nonnegative().nullish(),
      windowDays: z.coerce.number().int().positive().nullish(),
    }),
    subject: (d) => `Sending is paused on ${d.accountName}`,
    content: (d, context) => {
      const days = d.windowDays ? ` over the last ${d.windowDays} days` : ''
      const why =
        d.reason === 'bounce_rate'
          ? `Too many of ${d.accountName}’s recent emails bounced${d.bouncePpm != null ? ` (${percent(d.bouncePpm)}${days})` : ''}, so we paused sending to protect your sender reputation.`
          : d.reason === 'complaint_rate'
            ? `Too many recipients reported ${d.accountName}’s recent emails as spam${d.complaintPpm != null ? ` (${percent(d.complaintPpm)}${days})` : ''}, so we paused sending to protect your sender reputation.`
            : d.reason === 'ses'
              ? `Amazon SES paused sending on ${d.accountName}, usually over its bounce or complaint rates. It stays paused until our team has looked into it.`
              : `Our team paused sending on ${d.accountName}.`
      return {
        product: MAIL_PRODUCT,
        heading: 'Sending is paused',
        blocks: [
          { kind: 'text', text: why },
          {
            kind: 'note',
            text: 'While it is paused, the API refuses new emails and queued ones are not sent.',
          },
          {
            kind: 'text',
            text: 'Reply to this email, or write to hello@mydomainshub.com, and a person will look into it with you.',
          },
        ],
        action: { label: 'Open the dashboard', href: mailLink(context, '/dashboard') },
        footer: [membersFooter(d.accountName)],
      }
    },
  }),

  mail_sending_warning: template({
    version: 1,
    category: 'transactional',
    schema: z.object({
      accountName: z.string().min(1).max(100),
      source: z.enum(['threshold', 'ses']),
      kind: z.string().min(1).max(60),
      bouncePpm: z.coerce.number().int().nonnegative().nullish(),
      complaintPpm: z.coerce.number().int().nonnegative().nullish(),
      pausePpm: z.coerce.number().int().positive().nullish(),
      windowDays: z.coerce.number().int().positive().nullish(),
      summary: z.string().max(500).nullish(),
    }),
    subject: (d) =>
      d.source === 'ses'
        ? `Amazon SES flagged ${d.accountName}’s sending`
        : d.kind === 'complaint_warning'
          ? `${d.accountName}: spam complaints are getting high`
          : `${d.accountName}: bounces are getting high`,
    content: (d, context) => {
      const days = d.windowDays ? `Over the last ${d.windowDays} days` : 'Recently'
      const rate = d.kind === 'complaint_warning' ? d.complaintPpm : d.bouncePpm
      const what = d.kind === 'complaint_warning' ? 'were reported as spam' : 'bounced'
      const blocks: EmailBlock[] =
        d.source === 'ses'
          ? [
              {
                kind: 'text',
                text: `Amazon SES, which sends ${d.accountName}’s email, raised a high-impact finding about its sending.`,
              },
              ...(d.summary ? [{ kind: 'note', text: d.summary } as const] : []),
              {
                kind: 'text',
                text: 'Look at who you send to: remove addresses that bounce, and send only to people who asked for your email. If it gets worse, sending can be paused.',
              },
            ]
          : [
              {
                kind: 'text',
                text: `${days}, ${rate != null ? percent(rate) : 'too many'} of ${d.accountName}’s emails ${what}.${d.pausePpm ? ` At ${percent(d.pausePpm)} we pause sending to protect every sender’s reputation.` : ' If it keeps rising, we pause sending to protect every sender’s reputation.'}`,
              },
              {
                kind: 'text',
                text:
                  d.kind === 'complaint_warning'
                    ? 'Send only to people who asked for your email, and make it easy to stop receiving it.'
                    : 'Remove addresses that bounce, and check how addresses are collected: a typo at sign-up bounces every time.',
              },
            ]
      return {
        product: MAIL_PRODUCT,
        heading:
          d.source === 'ses' ? 'Amazon SES flagged your sending' : 'Your sending needs attention',
        blocks,
        action: { label: 'Open the dashboard', href: mailLink(context, '/dashboard') },
        footer: [membersFooter(d.accountName)],
      }
    },
  }),
} as const

export type NoticeKind = keyof typeof NOTICE_TEMPLATES

export function isNoticeKind(kind: string): kind is NoticeKind {
  return Object.hasOwn(NOTICE_TEMPLATES, kind)
}

export type RenderOutcome =
  | { ok: true; notice: RenderedNotice }
  /** A kind we have no template for, or data the template cannot use: never retried. */
  | { ok: false; reason: string }

/** One queued email, rendered — or why it cannot be. */
export function renderNotice(kind: string, data: unknown, context: NoticeContext): RenderOutcome {
  if (!isNoticeKind(kind)) return { ok: false, reason: `unknown kind ${kind}` }
  const entry = NOTICE_TEMPLATES[kind] as Template<z.ZodType>
  const parsed = entry.schema.safeParse(data)
  if (!parsed.success) {
    return {
      ok: false,
      reason: `bad data for ${kind}: ${parsed.error.issues.map((issue) => issue.path.join('.') || 'data').join(', ')}`,
    }
  }
  const subject = entry.subject(parsed.data, context)
  const content = entry.content(parsed.data, context)
  const name = (data as { name?: unknown } | null)?.name
  const greeting =
    typeof name === 'string' && name.trim() && name.length <= 40 ? `Hi ${name.trim()},` : null
  const { html, text } = renderEmail({
    ...content,
    blocks: greeting ? [{ kind: 'text', text: greeting }, ...content.blocks] : content.blocks,
  })
  return {
    ok: true,
    notice: {
      subject: context.testMode ? `[Test] ${subject}` : subject,
      html,
      text,
      version: `${kind}@${entry.version}`,
      category: entry.category,
      tags: [entry.category, kind],
      fromName: content.product ?? EMAIL_BRAND.name,
    },
  }
}
