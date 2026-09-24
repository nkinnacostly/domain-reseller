import type { Contact, GatewayErrorCode } from '@dr/shared'
import type DomainNameApi from 'nodejs-dna'
import type { DnaContact, DnaContactSet, DnaDomain, DnaResult } from 'nodejs-dna'
import type { WriteTarget } from '../dna/client'
import { type Exchange, withExchanges } from '../dna/transport'
import { type Semaphore, supplierSlots } from '../lib/semaphore'

/**
 * The registry operations provisioning needs, with every outcome made
 * explicit. `unknown` is its own answer, never folded into success or
 * failure (I2) — the saga resolves it by reading, not by writing again.
 */

export type RegistryDomain = {
  registeredAt: string | null
  expiresAt: string | null
  nameservers: string[]
  transferLock: boolean
  privacy: boolean
}

type Unsettled =
  | { kind: 'unknown'; code: string; message: string }
  /** Credentials or allowlisting: an operations problem, not this domain's. */
  | { kind: 'blocked'; code: 'SUPPLIER_AUTH' | 'SUPPLIER_IP_BLOCKED'; message: string }

export type Lookup = { kind: 'found'; domain: RegistryDomain } | { kind: 'not_found' } | Unsettled

export type Write<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'rejected'; code: GatewayErrorCode; message: string }
  | Unsettled

export type RegisterInput = {
  domainName: string
  periodYears: number
  contact: Contact
  privacy: boolean
}

/** One domain as the supplier's portfolio listing shows it (PRD §13.5). */
export type RegistryListing = {
  domainName: string
  status: string
  expiresAt: string | null
  nameservers: string[]
  transferLock: boolean
  privacy: boolean
  /** The supplier's own setting — "AutoRenew" by default (backlog L18). */
  renewalMode: string | null
}

export interface PortfolioReader {
  listPage(skip: number, take: number): Promise<Write<{ items: RegistryListing[]; total: number }>>
}

export interface Registrar {
  lookup(domainName: string): Promise<Lookup>
  register(input: RegisterInput): Promise<Write<RegistryDomain>>
  /** Adds `years` to the registration. The answer's date is a hint: read the record back. */
  renew(domainName: string, years: number): Promise<Write<{ expiresAt: string | null }>>
  setNameservers(domainName: string, nameservers: string[]): Promise<Write<string[]>>
}

export type CallRecord = {
  operation: string
  /** Null for calls about the whole portfolio. */
  domainName: string | null
  outcome: 'ok' | 'not_found' | 'rejected' | 'blocked' | 'unknown'
  httpStatus: number | null
  errorCode: string | null
  message: string | null
  durationMs: number
}

/** I7: receives every call before the saga acts on it. A throw stops the job. */
export type AuditSink = (record: CallRecord) => Promise<void>

type Verdict =
  | { outcome: 'ok' }
  | { outcome: 'not_found'; message: string }
  | { outcome: 'rejected'; code: GatewayErrorCode; message: string }
  | { outcome: 'blocked'; code: 'SUPPLIER_AUTH' | 'SUPPLIER_IP_BLOCKED'; message: string }
  | { outcome: 'unknown'; code: string; message: string }

/** The supplier's own words, from its error body. Kept for operations, never shown. */
export function supplierMessage(body: unknown): string {
  const error = (body as { error?: Record<string, unknown> } | null)?.error
  if (!error || typeof error !== 'object') return ''
  const parts = [error.message, error.details]
  const validation = error.validationErrors
  if (Array.isArray(validation)) {
    for (const item of validation) {
      if (item && typeof item === 'object' && 'message' in item) parts.push(item.message)
    }
  }
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' — ')
    .slice(0, 300)
}

/** Supplier refusal → our taxonomy (PRD §13.8). Order matters: most specific first. */
export function classifyRefusal(message: string): GatewayErrorCode {
  if (/balance|insufficient|credit|fund/i.test(message)) return 'SUPPLIER_INSUFFICIENT_FUNDS'
  if (/\btld\b|extension|not supported|unsupported/i.test(message)) return 'TLD_UNSUPPORTED'
  if (/name ?servers?\b|\bhost/i.test(message)) return 'NAMESERVER_INVALID'
  if (/contact|phone|e-?mail|address|zip|postal|city|country|first ?name|last ?name/i.test(message))
    return 'CONTACT_INVALID'
  if (/not available|already|exist|taken|in use|registered/i.test(message)) return 'DOMAIN_TAKEN'
  return 'REGISTRATION_FAILED'
}

/** What one HTTP exchange tells us, regardless of what the SDK made of it. */
export function judgeExchange(exchange: Exchange | undefined): Verdict {
  if (!exchange) {
    return { outcome: 'unknown', code: 'NO_EXCHANGE', message: 'No request was recorded' }
  }
  if (exchange.status === null) {
    const code = exchange.networkError ?? 'NETWORK'
    return { outcome: 'unknown', code, message: `No answer from the supplier (${code})` }
  }
  const { status } = exchange
  if (status >= 200 && status < 300) return { outcome: 'ok' }
  const message = supplierMessage(exchange.body) || `HTTP ${status}`
  if (status === 401 || status === 301 || status === 302) {
    return { outcome: 'blocked', code: 'SUPPLIER_AUTH', message }
  }
  // The supplier answers ordinary refusals with 403 too — seen in the sandbox
  // on 23 Sept 2026 for a registry EPP error — so only an address or
  // allowlist complaint, or a bare 403, is an operations problem.
  if (
    status === 403 &&
    (!supplierMessage(exchange.body) || /\bip\b|allow ?list|white ?list/i.test(message))
  ) {
    return { outcome: 'blocked', code: 'SUPPLIER_IP_BLOCKED', message }
  }
  if (status === 404) return { outcome: 'not_found', message }
  // A timeout, throttle or server error: the write may or may not have landed.
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: 'unknown', code: `HTTP_${status}`, message }
  }
  return { outcome: 'rejected', code: classifyRefusal(message), message }
}

const ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i
/**
 * The supplier's clock. Its dates carry no zone: a sandbox registration made
 * at 08:44 UTC on 23 Sept 2026 came back as starting "11:44:10" — Istanbul
 * time, UTC+3 all year since 2016.
 */
const SUPPLIER_OFFSET = '+03:00'

/**
 * A supplier date as an ISO instant. The raw body is preferred: the SDK
 * re-formats dates in the gateway's local time and drops the zone.
 */
export function supplierDate(raw: unknown, fallback?: string): string | null {
  for (const value of [raw, fallback]) {
    if (typeof value !== 'string' || value.trim() === '') continue
    const text = value.trim()
    const parsed = new Date(ZONE.test(text) ? text : `${text}${SUPPLIER_OFFSET}`)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return null
}

export function toRegistryDomain(sdk: DnaDomain, body: unknown): RegistryDomain {
  const raw = (body ?? {}) as Record<string, unknown>
  const nameservers = Array.isArray(raw.nameservers)
    ? raw.nameservers.map(String)
    : (sdk.NameServers ?? [])
  return {
    registeredAt: supplierDate(raw.startDate, sdk.Dates?.Start),
    expiresAt: supplierDate(raw.expirationDate, sdk.Dates?.Expiration),
    nameservers: nameservers.map((host) => host.toLowerCase()),
    transferLock: sdk.LockStatus === 'true',
    privacy: sdk.PrivacyProtectionStatus === 'true',
  }
}

/** The REST list sends a numeric status where info sends a word (SDK DOMAIN_STATUS_MAP). */
const STATUS_WORDS: Record<string, string> = {
  0: 'Active',
  1: 'WaitingForRegistration',
  2: 'WaitingForDocument',
  3: 'WaitingForIncomingTransfer',
  4: 'TransferredOut',
  7: 'PendingDelete',
  8: 'Deleted',
  9: 'ConfirmationEmailSend',
  11: 'WaitingForOutgoingTransfer',
}

export function toListing(item: unknown): RegistryListing | null {
  if (!item || typeof item !== 'object') return null
  const raw = item as Record<string, unknown>
  if (typeof raw.domainName !== 'string' || raw.domainName === '') return null
  const status = raw.status ?? raw.statusCode
  return {
    domainName: raw.domainName.toLowerCase(),
    status:
      typeof status === 'number' || /^\d+$/.test(String(status ?? ''))
        ? (STATUS_WORDS[String(status)] ?? String(status))
        : String(status ?? ''),
    expiresAt: supplierDate(raw.expirationDate),
    nameservers: Array.isArray(raw.nameservers)
      ? raw.nameservers.map((host) => String(host).toLowerCase())
      : [],
    transferLock: raw.lockStatus === true,
    privacy: raw.privacyProtectionStatus === true,
    renewalMode: typeof raw.renewalMode === 'string' ? raw.renewalMode : null,
  }
}

/** Our contact → the supplier's ContactInfo (PRD FR-A4). */
export function toDnaContact(contact: Contact): DnaContact {
  return {
    FirstName: contact.firstName,
    LastName: contact.lastName,
    Company: contact.company ?? '',
    EMail: contact.email,
    AddressLine1: contact.addressLine1,
    AddressLine2: contact.addressLine2 ?? '',
    AddressLine3: contact.addressLine3 ?? '',
    City: contact.city,
    State: contact.state,
    ZipCode: contact.zipCode,
    Country: contact.country,
    Phone: contact.phone,
    PhoneCountryCode: contact.phoneCountryCode,
    Fax: '',
    FaxCountryCode: '',
  }
}

/** Checkout takes one person, who holds every role until contact profiles exist. */
export function contactSet(contact: Contact): DnaContactSet {
  const info = toDnaContact(contact)
  return { Registrant: info, Administrative: info, Technical: info, Billing: info }
}

function unsettled(verdict: Verdict): Unsettled | null {
  if (verdict.outcome === 'blocked') {
    return { kind: 'blocked', code: verdict.code, message: verdict.message }
  }
  if (verdict.outcome === 'unknown') {
    return { kind: 'unknown', code: verdict.code, message: verdict.message }
  }
  return null
}

export function createDnaRegistrar(deps: {
  client: DomainNameApi
  environment: WriteTarget
  audit: AuditSink
  slots?: Semaphore
}): Registrar & PortfolioReader {
  const slots = deps.slots ?? supplierSlots

  async function call<T>(
    operation: string,
    domainName: string | null,
    run: () => Promise<T>,
  ): Promise<{ result: T | null; verdict: Verdict; body: unknown }> {
    const started = Date.now()
    let result: T | null = null
    let exchange: Exchange | undefined
    try {
      const recorded = await slots.run(() => withExchanges(run))
      result = recorded.result
      exchange = recorded.exchanges.at(-1)
    } catch {
      // The SDK catches its own errors, so this is ours or a slot timeout.
      // With no exchange recorded, the verdict below is `unknown`.
    }
    const verdict = judgeExchange(exchange)
    await deps.audit({
      operation,
      domainName,
      outcome: verdict.outcome,
      httpStatus: exchange?.status ?? null,
      errorCode: 'code' in verdict ? verdict.code : null,
      message: 'message' in verdict ? verdict.message : null,
      durationMs: Date.now() - started,
    })
    return { result, verdict, body: exchange?.body }
  }

  function parsed(result: DnaResult<DnaDomain> | null, body: unknown): RegistryDomain | null {
    return result?.result === 'OK' ? toRegistryDomain(result.data, body) : null
  }

  return {
    async lookup(domainName) {
      const { result, verdict, body } = await call('GetDetails', domainName, () =>
        deps.client.GetDetails(domainName),
      )
      if (verdict.outcome === 'not_found') return { kind: 'not_found' }
      if (verdict.outcome === 'ok') {
        const domain = parsed(result, body)
        return domain
          ? { kind: 'found', domain }
          : { kind: 'unknown', code: 'UNPARSEABLE', message: 'Details could not be read' }
      }
      // A refused read decides nothing about the registry's state.
      return (
        unsettled(verdict) ?? {
          kind: 'unknown',
          code: 'LOOKUP_REFUSED',
          message: 'message' in verdict ? verdict.message : 'Lookup refused',
        }
      )
    },

    async register({ domainName, periodYears, contact, privacy }) {
      const { result, verdict, body } = await call('RegisterWithContactInfo', domainName, () =>
        // Registered on the supplier's default nameservers: the customer's
        // are applied next, so a bad one never costs the registration (FR-R5).
        // Transfer lock on by default (FR-R6).
        deps.client.RegisterWithContactInfo(
          domainName,
          periodYears,
          contactSet(contact),
          [],
          true,
          privacy,
        ),
      )
      if (verdict.outcome === 'ok') {
        const domain = parsed(result, body)
        // Accepted but unreadable: it may well be registered — read, don't guess.
        return domain
          ? { kind: 'ok', data: domain }
          : {
              kind: 'unknown',
              code: 'UNPARSEABLE',
              message: 'Registration answer could not be read',
            }
      }
      if (verdict.outcome === 'rejected')
        return { kind: 'rejected', code: verdict.code, message: verdict.message }
      if (verdict.outcome === 'not_found') {
        return { kind: 'rejected', code: 'REGISTRATION_FAILED', message: verdict.message }
      }
      return unsettled(verdict) as Unsettled
    },

    async renew(domainName, years) {
      const { result, verdict, body } = await call('Renew', domainName, () =>
        deps.client.Renew(domainName, years),
      )
      if (verdict.outcome === 'ok') {
        const raw = (body ?? {}) as { expirationDate?: unknown }
        const sdk = result && result.result === 'OK' ? result.data?.ExpirationDate : undefined
        return {
          kind: 'ok',
          data: {
            expiresAt: supplierDate(raw.expirationDate, typeof sdk === 'string' ? sdk : undefined),
          },
        }
      }
      if (verdict.outcome === 'rejected')
        return { kind: 'rejected', code: verdict.code, message: verdict.message }
      if (verdict.outcome === 'not_found') {
        return { kind: 'rejected', code: 'DOMAIN_NOT_FOUND', message: verdict.message }
      }
      return unsettled(verdict) as Unsettled
    },

    async setNameservers(domainName, nameservers) {
      const { result, verdict } = await call('ModifyNameServer', domainName, () =>
        deps.client.ModifyNameServer(domainName, nameservers),
      )
      if (verdict.outcome === 'ok') {
        const applied =
          result && result.result === 'OK' && Array.isArray(result.data.NameServers)
            ? result.data.NameServers.map((host) => String(host).toLowerCase())
            : nameservers
        return { kind: 'ok', data: applied }
      }
      if (verdict.outcome === 'rejected')
        return { kind: 'rejected', code: verdict.code, message: verdict.message }
      if (verdict.outcome === 'not_found') {
        return { kind: 'rejected', code: 'DOMAIN_NOT_FOUND', message: verdict.message }
      }
      return unsettled(verdict) as Unsettled
    },

    async listPage(skip, take) {
      // Read from the raw body: the SDK's GetList looks for `nameServers`
      // where the API sends `nameservers`, so it always reports none.
      const { verdict, body } = await call('GetList', null, () =>
        deps.client.GetList({ SkipCount: skip, MaxResultCount: take }),
      )
      if (verdict.outcome === 'ok') {
        const page = body as { items?: unknown; totalCount?: unknown } | undefined
        const total = Number(page?.totalCount)
        if (!Array.isArray(page?.items) || !Number.isFinite(total)) {
          return {
            kind: 'unknown',
            code: 'UNPARSEABLE',
            message: 'Portfolio page could not be read',
          }
        }
        const items = page.items
          .map(toListing)
          .filter((listing): listing is RegistryListing => listing !== null)
        return { kind: 'ok', data: { items, total } }
      }
      return (
        unsettled(verdict) ?? {
          kind: 'unknown',
          code: 'LIST_REFUSED',
          message: 'message' in verdict ? verdict.message : 'Listing refused',
        }
      )
    },
  }
}
