import type { Contact, GatewayErrorCode, TransferCheckResult, TransferRefusal } from '@dr/shared'
import type DomainNameApi from 'nodejs-dna'
import type { DnaContact, DnaContactSet, DnaDomain, DnaResult } from 'nodejs-dna'
import type { WriteTarget } from '../dna/client'
import { type Exchange, withExchanges } from '../dna/transport'
import { type Priority, type Semaphore, supplierSlots } from '../lib/semaphore'

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
  /**
   * The supplier's word for the domain's state in our account — 'Active',
   * 'WaitingForIncomingTransfer', … (STATUS_WORDS). Absent where an answer
   * carries none. A transfer in is judged by it (transferState).
   */
  status?: string
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

/** A read that answers with something other than the domain record. */
export type Reading<T> = { kind: 'found'; data: T } | { kind: 'not_found' } | Unsettled

/**
 * A settings write. Its answer carries nothing we keep: whatever the
 * registry says it did, what it now holds is read back (I2).
 */
export type SettingWrite =
  | { kind: 'ok' }
  | { kind: 'rejected'; code: string; message: string }
  | Unsettled

/**
 * One contact as the registry holds it, flattened the way the SDK sends it:
 * SaveContacts joins address lines 1 and 2 into one `address`.
 */
export type RegistryContact = {
  firstName: string
  lastName: string
  company: string
  email: string
  address: string
  city: string
  state: string
  zipCode: string
  country: string
  phoneCountryCode: string
  phone: string
}

export type ContactRole = 'registrant' | 'administrative' | 'technical' | 'billing'
export type RegistryContacts = Partial<Record<ContactRole, RegistryContact>>

/** Registry-side settings (FR-DS1, FR-DS3, FR-DS4): each write is judged, then read back. */
export interface SettingsRegistrar {
  lookup(domainName: string): Promise<Lookup>
  contacts(domainName: string): Promise<Reading<RegistryContacts>>
  setTransferLock(domainName: string, locked: boolean): Promise<SettingWrite>
  setPrivacy(domainName: string, enabled: boolean): Promise<SettingWrite>
  /** Checkout's one person holds every role, so all four are saved together. */
  updateContacts(domainName: string, contact: Contact): Promise<SettingWrite>
}

/** FR-DS5, FR-T5: the domain's transfer code, fetched on demand and never kept (SEC-12). */
export interface AuthCodeReader {
  authCode(domainName: string): Promise<Reading<string>>
}

export type TransferInput = {
  domainName: string
  /** The customer's transfer code: sent to the supplier, and to no log or record (N13). */
  authCode: string
  periodYears: number
  contact: Contact
}

/** CheckTransfer's verdict. A refusal of the check itself is still an answer: not transferable. */
export type TransferCheckAnswer = { kind: 'ok'; data: TransferCheckResult } | Unsettled

/** Transfer's answer. `ok` means the registry took the request — not that the domain moved. */
export type TransferWrite =
  | { kind: 'ok' }
  | {
      kind: 'rejected'
      code: TransferRefusal | 'SUPPLIER_INSUFFICIENT_FUNDS'
      message: string
    }
  | Unsettled

/**
 * Transfers in (PRD E9). Kept apart from Registrar so the doubles written
 * before transfers existed still type-check; the real registrar is both.
 */
export interface TransferRegistrar {
  lookup(domainName: string): Promise<Lookup>
  /** CheckTransfer: a read, safe to repeat. Asked before money moves and before Transfer (FR-T1, N4). */
  checkTransfer(domainName: string, authCode: string): Promise<TransferCheckAnswer>
  /** Transfer: a write with no idempotency key (N3). */
  transfer(input: TransferInput): Promise<TransferWrite>
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

/**
 * A transfer refusal in the supplier's words → our reason (FR-T1). The
 * supplier's text is read, never shown (N10). Most specific first.
 */
export function classifyTransferRefusal(message: string): TransferRefusal {
  if (/auth|epp|transfer ?code|password|authori[sz]ation/i.test(message)) {
    return 'AUTH_CODE_INVALID'
  }
  // "Lock", "locked", "TransferLock", "clientTransferProhibited" — but not "blocked".
  if (/(?<![a-z])lock|transfer ?lock|prohibit/i.test(message)) return 'TRANSFER_LOCKED'
  return 'NOT_TRANSFERABLE'
}

/**
 * Takes a secret out of supplier text before it is recorded (N13): a registry
 * error can quote the transfer code it refused.
 */
export function redact(text: string, secret: string | undefined): string {
  if (!secret) return text
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(escaped, 'gi'), '[redacted]')
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

/** The REST API sends a status as a number (SDK DOMAIN_STATUS_MAP); we keep the word. */
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
  12: 'PendingHold',
  15: 'ModificationPending',
  18: 'InCase',
  19: 'PendingRestore',
}

/** A status as a word, whether the supplier sent the word or its number. */
export function statusWord(status: unknown): string {
  const text = String(status ?? '').trim()
  return /^\d+$/.test(text) ? (STATUS_WORDS[text] ?? text) : text
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
    status: statusWord(raw.status ?? sdk.Status),
  }
}

/**
 * Where a transfer in stands, by the supplier's status for the domain in our
 * account (PRD FR-T3 — the REST API has no QueryTransfer):
 * - `landed`  — in our account and active: the transfer completed;
 * - `waiting` — the request is with the current registrar;
 * - `gone`    — the request was cancelled or refused, or the domain left us;
 * - `unclear` — anything else. Never guessed either way (I2).
 */
export type TransferState = 'landed' | 'waiting' | 'gone' | 'unclear'

export function transferState(status: string | undefined): TransferState {
  const word = statusWord(status)
  if (/^(active|ok)$/i.test(word)) return 'landed'
  if (/incoming ?transfer|pending ?transfer|confirmation ?email/i.test(word)) return 'waiting'
  if (/transferred ?out|^deleted$|cancel|reject/i.test(word)) return 'gone'
  return 'unclear'
}

export function toListing(item: unknown): RegistryListing | null {
  if (!item || typeof item !== 'object') return null
  const raw = item as Record<string, unknown>
  if (typeof raw.domainName !== 'string' || raw.domainName === '') return null
  const status = raw.status ?? raw.statusCode
  return {
    domainName: raw.domainName.toLowerCase(),
    status: statusWord(status),
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

/** A settings refusal → our code. Anything not about the contact is the registry's own call. */
export function classifySettingRefusal(message: string): string {
  if (/contact|phone|e-?mail|address|zip|postal|city|country|first ?name|last ?name/i.test(message))
    return 'CONTACT_INVALID'
  return 'REGISTRY_REFUSED'
}

const text = (...values: unknown[]) =>
  values.find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? ''

const ROLE_BY_TYPE: Record<string, ContactRole> = {
  registrant: 'registrant',
  admin: 'administrative',
  administrative: 'administrative',
  tech: 'technical',
  technical: 'technical',
  billing: 'billing',
}

/**
 * The contacts in a raw `domains/info` body, read with the same field names
 * the SDK's parseContactInfo accepts. From the body, not the SDK's result:
 * our typings for that shape are a guess, the body is what was sent.
 */
export function toRegistryContacts(body: unknown): RegistryContacts | null {
  const list = (body as { contacts?: unknown } | null)?.contacts
  if (!Array.isArray(list)) return null
  const contacts: RegistryContacts = {}
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const role = ROLE_BY_TYPE[text(raw.contactType, raw.type).toLowerCase()]
    if (!role) continue
    contacts[role] = {
      firstName: text(raw.firstName),
      lastName: text(raw.lastName),
      company: text(raw.companyName, raw.organizationName, raw.company),
      email: text(raw.eMail, raw.emailAddress, raw.email),
      address: [text(raw.address, raw.addressLine1), text(raw.addressLine2), text(raw.addressLine3)]
        .filter(Boolean)
        .join(' '),
      city: text(raw.city),
      state: text(raw.state, raw.stateOrProvince),
      zipCode: text(raw.postalCode, raw.zipCode),
      country: text(raw.country, raw.countryCode),
      phoneCountryCode: text(raw.phoneCountryCode),
      phone: text(raw.phone, raw.phoneNumber),
    }
  }
  return contacts
}

const squash = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
const digits = (value: string) => value.replace(/\D/g, '')

/** The number with its dialling code, whether the registry keeps them apart or together. */
function fullNumber(countryCode: string, phone: string): string {
  const code = digits(countryCode)
  const number = digits(phone)
  return code && number.startsWith(code) && number.length > 9 ? number : `${code}${number}`
}

/** What we sent, in the registry's flattened shape. The SDK drops address line 3. */
export function asRegistryContact(contact: Contact): RegistryContact {
  return {
    firstName: contact.firstName,
    lastName: contact.lastName,
    company: contact.company ?? '',
    email: contact.email,
    address: [contact.addressLine1, contact.addressLine2].filter(Boolean).join(' '),
    city: contact.city,
    state: contact.state,
    zipCode: contact.zipCode,
    country: contact.country,
    phoneCountryCode: contact.phoneCountryCode,
    phone: contact.phone,
  }
}

/**
 * Field by field, after the normalising registries do: case, spacing, and
 * the phone's dialling code kept apart or joined on.
 */
export function sameContact(a: RegistryContact, b: RegistryContact): boolean {
  const fields = [
    'firstName',
    'lastName',
    'company',
    'email',
    'address',
    'city',
    'state',
    'zipCode',
    'country',
  ] as const
  return (
    fields.every((field) => squash(a[field]) === squash(b[field])) &&
    fullNumber(a.phoneCountryCode, a.phone) === fullNumber(b.phoneCountryCode, b.phone)
  )
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
  /** How long a call may wait for a supplier slot, and in which lane. Default: its turn, however long. */
  slotWait?: { waitMs: number; priority: Priority }
}): Registrar & PortfolioReader & SettingsRegistrar & AuthCodeReader & TransferRegistrar {
  const slots = deps.slots ?? supplierSlots

  async function call<T>(
    operation: string,
    domainName: string | null,
    run: () => Promise<T>,
    /** Scrubbed from everything recorded about the call (N13). */
    secret?: string,
  ): Promise<{ result: T | null; verdict: Verdict; body: unknown }> {
    const started = Date.now()
    let result: T | null = null
    let exchange: Exchange | undefined
    try {
      const recorded = await slots.run(() => withExchanges(run), deps.slotWait)
      result = recorded.result
      exchange = recorded.exchanges.at(-1)
    } catch {
      // The SDK catches its own errors, so this is ours or a slot timeout.
      // With no exchange recorded, the verdict below is `unknown`.
    }
    const judged = judgeExchange(exchange)
    const verdict: Verdict =
      'message' in judged ? { ...judged, message: redact(judged.message, secret) } : judged
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

  /** A settings write, judged from the exchange alone. */
  async function settingWrite(
    operation: string,
    domainName: string,
    run: () => Promise<unknown>,
  ): Promise<SettingWrite> {
    const { verdict } = await call(operation, domainName, run)
    if (verdict.outcome === 'ok') return { kind: 'ok' }
    if (verdict.outcome === 'rejected') {
      return {
        kind: 'rejected',
        code: classifySettingRefusal(verdict.message),
        message: verdict.message,
      }
    }
    if (verdict.outcome === 'not_found') {
      return { kind: 'rejected', code: 'DOMAIN_NOT_FOUND', message: verdict.message }
    }
    return unsettled(verdict) as Unsettled
  }

  /** A read of `domains/info` that wants something other than the domain record. */
  async function infoRead<T>(
    operation: string,
    domainName: string,
    run: () => Promise<unknown>,
    pick: (body: unknown) => T | null,
    missing = { code: 'UNPARSEABLE', message: `${operation} answer could not be read` },
  ): Promise<Reading<T>> {
    const { verdict, body } = await call(operation, domainName, run)
    if (verdict.outcome === 'not_found') return { kind: 'not_found' }
    if (verdict.outcome === 'ok') {
      const data = pick(body)
      return data === null ? { kind: 'unknown', ...missing } : { kind: 'found', data }
    }
    return (
      unsettled(verdict) ?? {
        kind: 'unknown',
        code: 'LOOKUP_REFUSED',
        message: 'message' in verdict ? verdict.message : 'Lookup refused',
      }
    )
  }

  const settings: Omit<SettingsRegistrar, 'lookup'> & AuthCodeReader = {
    contacts: (domainName) =>
      infoRead(
        'GetContacts',
        domainName,
        () => deps.client.GetContacts(domainName),
        (body) => {
          const contacts = toRegistryContacts(body)
          return contacts?.registrant ? contacts : null
        },
      ),

    // Not through the SDK: its DisableTheftProtectionLock posts to domains/lock
    // with lockStatus false, a field the API does not have — the supplier's
    // OpenAPI spec has POST domains/lock and POST domains/unlock, each taking
    // only the name. In the sandbox (24 Sept 2026) the SDK's call answered 204
    // and the domain stayed locked.
    setTransferLock: (domainName, locked) =>
      settingWrite(
        locked ? 'EnableTheftProtectionLock' : 'DisableTheftProtectionLock',
        domainName,
        async () => {
          const rest = deps.client.client
          if (!rest.post) throw new Error('Only the REST client can change the lock')
          // It throws on a non-2xx, as the SDK's own methods do inside; the
          // recorded exchange is what decides, so the throw is not needed.
          return rest
            .post(locked ? 'domains/lock' : 'domains/unlock', { domainName })
            .catch(() => null)
        },
      ),

    setPrivacy: (domainName, enabled) =>
      settingWrite('ModifyPrivacyProtectionStatus', domainName, () =>
        deps.client.ModifyPrivacyProtectionStatus(domainName, enabled),
      ),

    updateContacts: (domainName, contact) =>
      settingWrite('SaveContacts', domainName, () =>
        deps.client.SaveContacts(domainName, contactSet(contact)),
      ),

    // The code rides in the raw body only: the audit keeps the operation and
    // outcome, never a body, so it cannot reach a log or a table (N13, SEC-13).
    authCode: (domainName) =>
      infoRead(
        'GetAuthCode',
        domainName,
        () => deps.client.GetDetails(domainName),
        (body) => {
          const raw = (body ?? {}) as { authCode?: unknown; eppCode?: unknown }
          const code = text(raw.authCode, raw.eppCode).trim()
          return code === '' ? null : code
        },
        { code: 'NO_AUTH_CODE', message: 'The registry record carries no transfer code' },
      ),
  }

  return {
    ...settings,

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

    async checkTransfer(domainName, authCode) {
      const { verdict, body } = await call(
        'CheckTransfer',
        domainName,
        () => deps.client.CheckTransfer(domainName, authCode),
        authCode,
      )
      if (verdict.outcome === 'ok') {
        // Read from the raw body: the SDK turns a missing field into `false`.
        const raw = (body ?? {}) as Record<string, unknown>
        if (typeof raw.transferAvailabilityStatus !== 'boolean') {
          return {
            kind: 'unknown',
            code: 'UNPARSEABLE',
            message: 'Transfer check could not be read',
          }
        }
        if (raw.transferAvailabilityStatus) return { kind: 'ok', data: { transferable: true } }
        const reason: TransferRefusal =
          raw.transferLock === true
            ? 'TRANSFER_LOCKED'
            : raw.authCodeIsValid === false
              ? 'AUTH_CODE_INVALID'
              : 'NOT_TRANSFERABLE'
        return { kind: 'ok', data: { transferable: false, reason } }
      }
      // A refused check is still the supplier's answer: not transferable, and why.
      if (verdict.outcome === 'rejected' || verdict.outcome === 'not_found') {
        return {
          kind: 'ok',
          data: { transferable: false, reason: classifyTransferRefusal(verdict.message) },
        }
      }
      return unsettled(verdict) as Unsettled
    },

    async transfer({ domainName, authCode, periodYears, contact }) {
      const { verdict } = await call(
        'Transfer',
        domainName,
        () => deps.client.Transfer(domainName, authCode, periodYears, contactSet(contact)),
        authCode,
      )
      // Sparse, like a registration's answer: the record is read afterwards.
      if (verdict.outcome === 'ok') return { kind: 'ok' }
      if (verdict.outcome === 'rejected' || verdict.outcome === 'not_found') {
        return {
          kind: 'rejected',
          // An empty float is ours to fix, not the domain's: keep it apart.
          code:
            verdict.outcome === 'rejected' && verdict.code === 'SUPPLIER_INSUFFICIENT_FUNDS'
              ? 'SUPPLIER_INSUFFICIENT_FUNDS'
              : classifyTransferRefusal(verdict.message),
          message: verdict.message,
        }
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
