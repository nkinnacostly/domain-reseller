import { SSL_TERM } from '@dr/shared'
import { BRAND_NAME } from '@/components/layout/brand'
import { LEGAL_DOCUMENTS } from '@/features/legal/lib/documents'
import { firstTermPhrase, renewalPhrase } from '@/features/pricing/lib/terms'
import { BUSINESS, SPONSORING_REGISTRAR } from '@/lib/business'
import type { QA } from './structured-data'

/**
 * /llms.txt and /llms-full.txt: the site in plain Markdown for language
 * models and AI agents (llmstxt.org — an H1, a summary, then lists of links).
 * No assistant has said it reads the file, so it is a cheap bet, not a
 * strategy: the pages themselves carry the same facts in their HTML.
 *
 * Every fact is one the site already states (N9b), and every price comes
 * with its renewal price (N8). Pure — the caller supplies prices and pages.
 */

export type PriceLine = {
  tld: string
  /** The shortest registration's price, for `registerYears` years. */
  register: string
  registerYears: number
  /** The shortest renewal's price, for `renewYears` years. */
  renew: string
  renewYears: number
  transfer: string | null
}

/** An SSL certificate as the SSL page shows it (FR-SSL-1). */
export type CertificateLine = { name: string; price: string; covers: string }

export type LlmsInput = {
  site: string
  /** Null when prices are withheld (N5b): the file then says so instead. */
  prices: { vatPct: number; extensionCount: number; popular: PriceLine[] } | null
  /** The SSL certificates on sale; empty when their prices are withheld. */
  certificates?: CertificateLine[]
}

const link = (site: string, path: string) => new URL(path, site).toString()

export const LLMS_PAGES = [
  {
    path: '/',
    title: 'Search for a domain',
    note: 'type a name to see whether it is free, across extensions, each with its registration and renewal price',
  },
  {
    path: '/pricing',
    title: 'Pricing',
    note: 'every extension with its registration, renewal and transfer price, and what makes up a price',
  },
  { path: '/domains', title: 'All domain extensions', note: 'one page per extension we sell' },
  {
    path: '/transfer',
    title: 'Transfer a domain in',
    note: 'checks at the registry whether a domain can move here, and what is in the way',
  },
  {
    path: '/ssl',
    title: 'SSL certificates',
    note: 'Sectigo PositiveSSL certificates priced in naira, set up and downloaded from your account; you install them yourself',
  },
  { path: '/search/bulk', title: 'Bulk domain search', note: 'check up to 500 names at once' },
  {
    path: '/whois',
    title: 'WHOIS lookup',
    note: 'a domain’s public registration record: registrar, dates, status, nameservers',
  },
  { path: '/help', title: 'Help centre', note: 'answers about buying, pointing and renewing' },
  { path: '/about', title: `About ${BRAND_NAME}`, note: 'who runs the service and how it works' },
  { path: '/contact', title: 'Contact', note: `email ${BUSINESS.email}` },
] as const

function priceLine(site: string, line: PriceLine): string {
  const transfer = line.transfer ? `; transfer in ${line.transfer}` : ''
  return `- [.${line.tld}](${link(site, `/domains/${line.tld}`)}): ${firstTermPhrase(line.tld, line.register, line.registerYears)}, then ${renewalPhrase(line.renew, line.renewYears)} to renew${transfer}`
}

/**
 * FR-SSL-1: each certificate with its price and the term in the page's words
 * — a one-year subscription that never renews by itself (N8, N9b).
 */
function certificateSection(site: string, certificates: CertificateLine[]): string[] {
  if (certificates.length === 0) return []
  return [
    '## SSL certificates',
    '',
    `Prices in naira, before VAT. Each is a ${SSL_TERM.short} with the certificate authority; certificates now last at most 200 days, so you reissue (free) within the year. It never renews by itself.`,
    '',
    ...certificates.map(
      (line) => `- [${line.name}](${link(site, '/ssl')}): ${line.price} — ${line.covers}`,
    ),
    '',
  ]
}

function header({ site, prices }: LlmsInput): string[] {
  const count = prices ? `${prices.extensionCount.toLocaleString('en-NG')} ` : ''
  const vat = prices ? `VAT at ${prices.vatPct}%` : 'VAT'
  return [
    `# ${BRAND_NAME}`,
    '',
    `> Domain name registration for Nigeria. Search ${count}domain extensions, pay in naira, and manage nameservers, the transfer lock, privacy, contacts and renewals from one account. Every price is shown next to its renewal price.`,
    '',
    `- Website: ${link(site, '/')}`,
    `- Operator: ${BUSINESS.operator}, trading as ${BRAND_NAME} — an authorised reseller, not itself ICANN-accredited. .com registrations are sponsored by ${SPONSORING_REGISTRAR.name} (IANA ID ${SPONSORING_REGISTRAR.ianaId}).`,
    `- Prices are in naira (NGN), before ${vat}, which checkout adds as its own line. Payment is through Flutterwave (card, bank transfer and its other methods), which adds its own processing fee on its payment page.`,
    '- A price is our supplier’s US-dollar price at the day’s exchange rate, plus the ICANN fee on generic extensions and the same flat margin on every extension.',
    '- We register and manage domains, and sell SSL certificates that you install on your own server or hosting; we do not host websites or email.',
    `- Checking a name: ${link(site, '/search')}?q=yourname.com shows whether it is free, with prices. A transfer check is ${link(site, '/transfer')}?domain=yourname.com.`,
    `- Contact: ${BUSINESS.email}`,
    '',
  ]
}

export function llmsTxt(input: LlmsInput): string {
  const { site, prices } = input
  return [
    ...header(input),
    '## Pages',
    '',
    ...LLMS_PAGES.map((page) => `- [${page.title}](${link(site, page.path)}): ${page.note}`),
    '',
    '## Popular extensions',
    '',
    ...(prices
      ? prices.popular.map((line) => priceLine(site, line))
      : ['Prices are briefly unavailable; see the pricing page.']),
    '',
    ...certificateSection(site, input.certificates ?? []),
    '## Optional',
    '',
    `- [Every extension and price, with the help centre’s answers](${link(site, '/llms-full.txt')})`,
    ...LEGAL_DOCUMENTS.map(
      (document) => `- [${document.title}](${link(site, document.href)}): ${document.summary}`,
    ),
    '',
  ].join('\n')
}

export function llmsFullTxt(
  input: LlmsInput & { all: PriceLine[]; faqs: { title: string; items: QA[] }[] },
): string {
  const { site, prices, all, faqs } = input
  return [
    ...header(input),
    '## Every extension',
    '',
    ...(prices && all.length > 0
      ? [
          `First-year, renewal and transfer prices in naira, before VAT. Each extension links to its own page.`,
          '',
          ...all.map((line) => priceLine(site, line)),
        ]
      : ['Prices are briefly unavailable; see the pricing page.']),
    '',
    ...faqs.flatMap((section) => [
      `## ${section.title}`,
      '',
      ...section.items.flatMap((item) => [`### ${item.q}`, '', item.a, '']),
    ]),
  ].join('\n')
}
