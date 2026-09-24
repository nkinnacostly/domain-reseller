import { z } from 'zod'

/**
 * RDAP — the registries' own public record of a domain (PRD ADR-003).
 *
 * DomainNameAPI has no WHOIS or RDAP lookup, so we ask the registry directly.
 * Only this file knows the wire format; everything downstream works with
 * `RdapRecord`. The /whois page (FR-PUB2) is the second consumer and imports
 * it from here; promote this and queries/rdap-lookup.ts to `src/lib` once the
 * transfer feature stops moving.
 */

/** TLD (or multi-label suffix) → the registry's RDAP base URL. */
export type RdapBootstrap = Record<string, string>

export type RdapRecord = {
  /** Normalised EPP statuses, e.g. `client transfer prohibited`. */
  statuses: string[]
  /** ISO timestamps. Null when the registry does not publish the event. */
  registeredAt: string | null
  lastTransferredAt: string | null
  expiresAt: string | null
  registrar: string | null
}

/**
 * `T` is what the caller parses out of a found record: the transfer check
 * needs `RdapRecord`; the WHOIS page adds the nameservers (FR-PUB2).
 */
export type RdapLookup<T = RdapRecord> =
  | { kind: 'found'; record: T }
  /** The registry has no record — nobody has registered the name. */
  | { kind: 'not-found' }
  /** The registry does not run RDAP, so there is nothing to ask. */
  | { kind: 'unsupported' }
  /** The registry runs RDAP but did not give us a usable answer. */
  | { kind: 'unavailable' }

const bootstrapSchema = z.object({
  services: z.array(z.tuple([z.array(z.string()), z.array(z.string())])),
})

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//

/**
 * HTTPS only — a registry record fetched over plain HTTP is not one we should
 * make decisions on. Loopback is the one exception: it never leaves the
 * machine and IANA never lists it, and it is how e2e points every lookup at a
 * local mock registry (RDAP_BOOTSTRAP_URL) instead of the real ones.
 */
export function isTrustedEndpoint(url: string): boolean {
  return url.startsWith('https://') || LOOPBACK.test(url)
}

/**
 * Flattens the IANA bootstrap file (RFC 9224) into a lookup table, keeping
 * only trusted endpoints (see isTrustedEndpoint).
 */
export function parseBootstrap(json: unknown): RdapBootstrap {
  const parsed = bootstrapSchema.parse(json)
  const table: RdapBootstrap = {}

  for (const [suffixes, urls] of parsed.services) {
    const base = urls.find(isTrustedEndpoint)
    if (!base) continue
    for (const suffix of suffixes) table[suffix.toLowerCase()] = base
  }

  return table
}

/** The RDAP base for a domain, by longest matching suffix as RFC 9224 requires. */
export function rdapBaseFor(bootstrap: RdapBootstrap, domain: string): string | null {
  const labels = domain.toLowerCase().split('.')

  for (let start = 1; start < labels.length; start += 1) {
    const base = bootstrap[labels.slice(start).join('.')]
    if (base) return base
  }

  return null
}

export function rdapDomainUrl(base: string, domain: string): string {
  const root = base.endsWith('/') ? base : `${base}/`
  return `${root}domain/${encodeURIComponent(domain.toLowerCase())}`
}

const domainSchema = z.object({
  status: z.array(z.string()).optional(),
  events: z.array(z.object({ eventAction: z.string(), eventDate: z.string() }).loose()).optional(),
  entities: z
    .array(
      z
        .object({
          roles: z.array(z.string()).optional(),
          vcardArray: z.tuple([z.string(), z.array(z.array(z.unknown()))]).optional(),
        })
        .loose(),
    )
    .optional(),
})

/**
 * Registries write statuses as RFC 8056 phrases (`client transfer prohibited`);
 * a few still send the EPP form (`clientTransferProhibited`). One shape.
 */
export function normaliseStatus(status: string): string {
  return status
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
}

function latestEvent(
  events: { eventAction: string; eventDate: string }[],
  action: string,
): string | null {
  const dates = events
    .filter((event) => event.eventAction.toLowerCase() === action)
    .map((event) => new Date(event.eventDate))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())

  return dates[0]?.toISOString() ?? null
}

function registrarName(entities: z.infer<typeof domainSchema>['entities']): string | null {
  const registrar = entities?.find((entity) => entity.roles?.includes('registrar'))
  const fn = registrar?.vcardArray?.[1].find((property) => property[0] === 'fn')
  const name = fn?.[3]
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

const nameserverSchema = z.object({
  nameservers: z.array(z.object({ ldhName: z.string().optional() }).loose()).optional(),
})

/** A hostname, so nothing but a nameserver's name ever reaches the page. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/

/**
 * The nameservers a registry lists for a domain (RFC 9083 §5.2), lowercased
 * and deduplicated. Empty when there are none or the answer is unreadable.
 */
export function parseRdapNameservers(json: unknown): string[] {
  const parsed = nameserverSchema.safeParse(json)
  if (!parsed.success) return []

  const names = (parsed.data.nameservers ?? [])
    .map((ns) => ns.ldhName?.trim().toLowerCase().replace(/\.$/, '') ?? '')
    .filter((name) => HOSTNAME.test(name))

  return [...new Set(names)]
}

/** Null when the response is not a domain object we can read. */
export function parseRdapDomain(json: unknown): RdapRecord | null {
  const parsed = domainSchema.safeParse(json)
  if (!parsed.success) return null

  const events = parsed.data.events ?? []

  return {
    statuses: (parsed.data.status ?? []).map(normaliseStatus),
    registeredAt: latestEvent(events, 'registration'),
    lastTransferredAt: latestEvent(events, 'transfer'),
    expiresAt: latestEvent(events, 'expiration'),
    registrar: registrarName(parsed.data.entities),
  }
}
