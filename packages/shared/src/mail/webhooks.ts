/**
 * Customer webhooks (MAIL-SPEC §6, MR6): the events an endpoint can ask for,
 * and which endpoints we will call. The dashboard checks a URL before it is
 * saved (migration 49's `is_webhook_url` checks again), and the mail worker
 * checks the address it actually connects to, every time — a name that
 * resolved to a public address when it was saved may not now.
 *
 * Only https, only public addresses: a webhook must never become a way to
 * reach inside our network or anyone's (SSRF). No URL shorteners or
 * redirects are followed by the worker either.
 */

export const WEBHOOK_EVENTS = [
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.failed',
  'domain.verified',
  'domain.failed',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export const isWebhookEvent = (value: unknown): value is WebhookEvent =>
  typeof value === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(value)

export type WebhookUrlRefusal =
  | 'not_url'
  | 'not_https'
  | 'credentials'
  | 'too_long'
  | 'ip_v6'
  | 'private_address'
  | 'internal_name'

export type WebhookUrlCheck = { ok: true; url: string } | { ok: false; reason: WebhookUrlRefusal }

type ParsedUrl = {
  protocol: string
  hostname: string
  username: string
  password: string
  hash: string
  href: string
}
const URLCtor = (globalThis as unknown as { URL: new (url: string) => ParsedUrl }).URL

const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
/** Names that only mean something inside a network (RFC 6761, 6762, 8375, 9476). */
const INTERNAL =
  /(^|\.)(localhost|local|internal|intranet|lan|localdomain|home\.arpa|invalid|test|onion)$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * The endpoint as it will be stored — the URL parser's own form, without a
 * fragment — or why it is refused. An IPv4 literal must be public; an IPv6
 * literal is refused (SQL stores host names and IPv4 only).
 */
export function checkWebhookUrl(input: string): WebhookUrlCheck {
  const text = input.trim()
  if (text.length === 0) return { ok: false, reason: 'not_url' }
  let url: ParsedUrl
  try {
    url = new URLCtor(text)
  } catch {
    return { ok: false, reason: 'not_url' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
  const host = url.hostname
  if (host.startsWith('[')) return { ok: false, reason: 'ip_v6' }
  if (IPV4.test(host)) {
    if (!isPublicAddress(host)) return { ok: false, reason: 'private_address' }
  } else if (host.length > 253 || !HOST.test(host) || INTERNAL.test(host)) {
    return { ok: false, reason: 'internal_name' }
  }
  url.hash = ''
  const href = url.href
  if (href.length > 500) return { ok: false, reason: 'too_long' }
  return { ok: true, url: href }
}

// ── Addresses ───────────────────────────────────────────────────────────────

function ipv4Bytes(ip: string): number[] | null {
  if (!IPV4.test(ip)) return null
  const bytes = ip.split('.').map(Number)
  return bytes.every((b) => b <= 255) ? bytes : null
}

/** IPv4 ranges that are not the public internet (RFC 6890 and friends). */
function isPublicV4([a = 0, b = 0, c = 0]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false // this, private, loopback, multicast, reserved
  if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
  if (a === 169 && b === 254) return false // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // TEST-NET-3
  return true
}

/** Eight 16-bit groups, or null; `::` and an IPv4 tail are expanded. */
function ipv6Groups(input: string): number[] | null {
  let ip = input.toLowerCase()
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone)
  const lastColon = ip.lastIndexOf(':')
  if (ip.includes('.')) {
    // An IPv4 tail (::ffff:10.0.0.1) is two groups written another way.
    const v4 = lastColon === -1 ? null : ipv4Bytes(ip.slice(lastColon + 1))
    if (!v4) return null
    const hex = (hi = 0, lo = 0) => ((hi << 8) | lo).toString(16)
    ip = `${ip.slice(0, lastColon + 1)}${hex(v4[0], v4[1])}:${hex(v4[2], v4[3])}`
  }
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part === '' ? [] : part.split(':'))
  const head = parse(halves[0] ?? '')
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const words = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  if (words.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null
  return words.map((w) => Number.parseInt(w, 16))
}

function isPublicV6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
  // ::ffff:a.b.c.d — an IPv4 address in IPv6 clothing: judged as IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicV4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255])
  }
  // Global unicast only (2000::/3), less the ranges inside it that are not
  // the internet or that tunnel to an address we cannot see.
  if ((g0 & 0xe000) !== 0x2000) return false
  if (g0 === 0x2001 && g1 < 0x200) return false // 2001::/23 IETF, Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return false // documentation
  if (g0 === 0x2002) return false // 6to4
  return true
}

/**
 * Whether the worker may connect to `ip` (as `dns.lookup` answers it, or an
 * IPv4 literal). Anything it cannot read is not public.
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = ipv4Bytes(ip)
  if (v4) return isPublicV4(v4)
  const v6 = ip.includes(':') ? ipv6Groups(ip.replace(/^\[|\]$/g, '')) : null
  return v6 ? isPublicV6(v6) : false
}
