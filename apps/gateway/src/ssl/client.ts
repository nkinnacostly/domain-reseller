import type { WriteTarget } from '../dna/client'
import { type JsonResponse, NoAnswer, requestJson } from '../lib/http'
import { type Priority, type Semaphore, supplierSlots } from '../lib/semaphore'
import type { AuditSink } from '../provisioning/registrar'
import { supplierMessage } from '../provisioning/registrar'

/**
 * DomainNameAPI's SSL API (PRD Appendix E), with every outcome explicit.
 *
 * Not through nodejs-dna: the SDK has no SSL methods, and it keeps the last
 * request and answer on the client — a generated private key would sit in
 * the gateway's memory there. Calls go out over HTTP/1.1 with certificates
 * checked (node:https), inside the supplier slots, and each is recorded for
 * its job without a body (I7, N13).
 *
 * Read in the sandbox on 2 Oct 2026: every call names the certificate by its
 * domain name; a "not found" is HTTP 403 with code `Ssl:10026`; an internal
 * error is 403 `Ssl:10048` or 500 and settles nothing.
 */

export const SSL_BASE_URL: Record<WriteTarget, string> = {
  production: 'https://api.domainresellerapi.com/api/v1',
  ote: 'https://ote.domainresellerapi.com/api/v1',
}

type Unsettled =
  | { kind: 'unknown'; code: string; message: string }
  /** Credentials or allowlisting: an operations problem, not this certificate's. */
  | { kind: 'blocked'; code: 'SUPPLIER_AUTH' | 'SUPPLIER_IP_BLOCKED'; message: string }

/** A read: the thing, nothing under that name, or no answer we can use. */
export type SslReading<T> = { kind: 'found'; data: T } | { kind: 'not_found' } | Unsettled

/** A write: taken, refused for a reason of ours to say, or unknown (I2). */
export type SslWrite<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'rejected'; code: string; message: string }
  | Unsettled

/** check-status: works for every name, wildcards included. */
export type SslStatusAnswer = {
  domainName: string
  status: string
  isConfigured: boolean
  isIssued: boolean
  /** ISO instant, or null. */
  certificateExpiresAt: string | null
}

/** GET /ssls/certificate — refuses a `*.` name, so wildcards have only check-status. */
export type SslDetails = {
  status: string
  packageCode: string | null
  isConfigured: boolean
  isIssued: boolean
  purchasedAt: string | null
  subscriptionEndsAt: string | null
  issuedAt: string | null
  validUntil: string | null
}

/** The issued certificate and its chain, PEM. Empty strings until the CA has it. */
export type SslContent = {
  certificate: string
  intermediates: string[]
  root: string
}

export type CsrSummary = {
  commonName: string
  alternativeNames: string[]
  isWildcard: boolean
  organization: string | null
  country: string | null
}

export type GeneratedCsr = { csr: string; privateKey: string }

export type ConfigureInput = {
  name: string
  csr: string
  approverEmail: string
  webServer: 'apache' | 'iis'
  extraNames: readonly string[]
  contact: SupplierSslContact
}

/** The contact in the supplier's ConfigureContactInput shape (Appendix E). */
export type SupplierSslContact = {
  firstName: string
  lastName: string
  companyName: string
  eMail: string
  address: string
  phoneCountryCode: string
  phone: string
  faxCountryCode: string
  fax: string
  country: string
  city: string
  state: string
  postalCode: string
}

export type GenerateCsrInput = {
  name: string
  alternativeNames: readonly string[]
  country: string
  state: string
  locality: string
  organization: string
  organizationUnit: string
}

export interface SslClient {
  status(name: string): Promise<SslReading<SslStatusAnswer>>
  details(name: string): Promise<SslReading<SslDetails>>
  content(name: string): Promise<SslReading<SslContent>>
  approvers(name: string, productCode: string): Promise<SslReading<string[]>>
  checkCsr(csr: string): Promise<SslReading<CsrSummary>>
  /** Not a purchase: a new key and request each time. The key goes to the caller, nowhere else. */
  generateCsr(input: GenerateCsrInput): Promise<SslReading<GeneratedCsr>>
  /** Buys the certificate: charges our float. No idempotency key (N3). */
  initialize(
    productCode: string,
    name: string,
  ): Promise<SslWrite<{ certificateId: string | null; status: string }>>
  configure(input: ConfigureInput): Promise<SslWrite<{ status: string }>>
  reissue(name: string, approverEmail: string | null): Promise<SslWrite<{ status: string }>>
}

/** Our word for a supplier refusal (`Ssl:NNNNN`), for the customer or for a person. */
const SSL_CODES: Record<string, string> = {
  'Ssl:10003': 'NOT_SUPPORTED',
  'Ssl:10004': 'CSR_INVALID',
  'Ssl:10014': 'APPROVER_INVALID',
  'Ssl:10019': 'CSR_NOT_WILDCARD',
  'Ssl:10027': 'SSL_WRONG_STATE',
  'Ssl:10035': 'VALIDATION_METHOD_UNSUPPORTED',
  'Ssl:10037': 'WEB_SERVER_UNSUPPORTED',
  'Ssl:10040': 'CSR_NAME_MISMATCH',
  'Dna.DomainService:Domain:10044': 'NAME_INVALID',
}

/** The code in an error body, as the supplier sent it: `Ssl:10026`, `API_301`… */
export function sslErrorCode(body: unknown): string | null {
  const error = (body as { error?: Record<string, unknown> } | null)?.error
  if (!error || typeof error !== 'object') return null
  const code = typeof error.code === 'string' ? error.code.trim() : ''
  if (code) return code
  const text = [error.message, error.details].filter((part) => typeof part === 'string').join(' ')
  return /\bAPI_\d{3}\b/.exec(text)?.[0] ?? null
}

/** Never keep a key, however the supplier echoes one (N13). */
function scrub(text: string): string {
  return text.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, '[PEM removed]')
}

export type SslVerdict =
  | { outcome: 'ok' }
  | { outcome: 'not_found'; message: string }
  | { outcome: 'rejected'; code: string; message: string }
  | { outcome: 'blocked'; code: 'SUPPLIER_AUTH' | 'SUPPLIER_IP_BLOCKED'; message: string }
  | { outcome: 'unknown'; code: string; message: string }

/** What one answer means — or no answer at all, which is never a "no" (I2). */
export function judgeSsl(answer: JsonResponse | NoAnswer): SslVerdict {
  if (answer instanceof NoAnswer) {
    const code = /timeout/i.test(answer.message) ? 'TIMEOUT' : 'NETWORK'
    return { outcome: 'unknown', code, message: `No answer from the supplier (${code})` }
  }
  const { status, body } = answer
  if (status >= 200 && status < 300) {
    const success = (body as { success?: unknown } | null)?.success
    if (success === false) {
      const message = scrub(String((body as { message?: unknown }).message ?? 'Refused'))
      return { outcome: 'rejected', code: 'SSL_REFUSED', message: message.slice(0, 300) }
    }
    return { outcome: 'ok' }
  }
  const message = scrub(supplierMessage(body) || `HTTP ${status}`)
  const code = sslErrorCode(body)
  if (code === 'API_301') return { outcome: 'blocked', code: 'SUPPLIER_IP_BLOCKED', message }
  if (code === 'API_350' || status === 402) {
    return { outcome: 'rejected', code: 'SUPPLIER_INSUFFICIENT_FUNDS', message }
  }
  if (code === 'API_429' || status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: 'unknown', code: `HTTP_${status}`, message }
  }
  if (status === 401 || status === 301 || status === 302) {
    return { outcome: 'blocked', code: 'SUPPLIER_AUTH', message }
  }
  if (code === 'Ssl:10026') return { outcome: 'not_found', message }
  // An internal error on their side settles nothing (seen as 403 Ssl:10048,
  // and as 403 with an empty code for a reissue).
  if (code === 'Ssl:10048' || (!code && /internal error/i.test(message))) {
    return { outcome: 'unknown', code: 'SUPPLIER_INTERNAL_ERROR', message }
  }
  if (
    status === 403 &&
    (!supplierMessage(body) || /\bip\b|allow ?list|white ?list/i.test(message))
  ) {
    return { outcome: 'blocked', code: 'SUPPLIER_IP_BLOCKED', message }
  }
  if (code && SSL_CODES[code]) return { outcome: 'rejected', code: SSL_CODES[code], message }
  if (status === 404) return { outcome: 'rejected', code: 'SSL_PRODUCT_UNKNOWN', message }
  if (status === 400) return { outcome: 'rejected', code: 'SSL_INVALID_REQUEST', message }
  return { outcome: 'rejected', code: 'SSL_REFUSED', message }
}

const ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i
/**
 * An SSL date as an ISO instant. Unlike the domain API (+03:00), the SSL
 * service's zoneless dates are UTC: a purchase at 11:45 UTC came back as
 * "11:45:37" while issue dates carried "+03:00" (sandbox, 2 Oct 2026).
 */
export function sslDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const text = value.trim()
  const parsed = new Date(ZONE.test(text) ? text : `${text}Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const bool = (value: unknown) => value === true

export type SslClientOptions = {
  environment: WriteTarget
  apiKey: string
  resellerId: string
  audit: AuditSink
  slots?: Semaphore
  /** How long a call may wait for a supplier slot, and in which lane. */
  slotWait?: { waitMs: number; priority: Priority }
  timeoutMs?: number
  request?: typeof requestJson
}

export function createSslClient(options: SslClientOptions): SslClient {
  const {
    environment,
    apiKey,
    resellerId,
    audit,
    slots = supplierSlots,
    slotWait = { waitMs: 60_000, priority: 'normal' as Priority },
    timeoutMs = 60_000,
    request = requestJson,
  } = options
  const base = SSL_BASE_URL[environment]
  const headers = { 'X-API-KEY': apiKey, __reseller: resellerId }

  async function call(
    operation: string,
    name: string | null,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<{ verdict: SslVerdict; body: unknown }> {
    const started = Date.now()
    let answer: JsonResponse | NoAnswer
    try {
      answer = await slots.run(
        () =>
          request(`${base}${path}`, {
            method,
            headers,
            timeoutMs,
            ...(body === undefined ? {} : { body }),
          }),
        slotWait,
      )
    } catch (error) {
      answer =
        error instanceof NoAnswer
          ? error
          : new NoAnswer(error instanceof Error ? error.message : 'No supplier slot')
    }
    const verdict = judgeSsl(answer)
    await audit({
      operation,
      domainName: name,
      outcome: verdict.outcome,
      httpStatus: answer instanceof NoAnswer ? null : answer.status,
      errorCode: 'code' in verdict ? verdict.code : null,
      message: 'message' in verdict ? verdict.message : null,
      durationMs: Date.now() - started,
    })
    return { verdict, body: answer instanceof NoAnswer ? null : answer.body }
  }

  function unsettled(verdict: SslVerdict): Unsettled {
    if (verdict.outcome === 'blocked') {
      return { kind: 'blocked', code: verdict.code, message: verdict.message }
    }
    if (verdict.outcome === 'unknown') {
      return { kind: 'unknown', code: verdict.code, message: verdict.message }
    }
    // A refusal of a read is not an answer about the certificate.
    return {
      kind: 'unknown',
      code: verdict.outcome === 'rejected' ? verdict.code : 'UNREADABLE',
      message: 'message' in verdict ? verdict.message : 'Unreadable answer',
    }
  }

  async function read<T>(
    operation: string,
    name: string | null,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    pick: (body: unknown) => T | null,
  ): Promise<SslReading<T>> {
    const { verdict, body: answer } = await call(operation, name, method, path, body)
    if (verdict.outcome === 'not_found') return { kind: 'not_found' }
    if (verdict.outcome !== 'ok') return unsettled(verdict)
    const data = pick(answer)
    return data === null
      ? { kind: 'unknown', code: 'UNPARSEABLE', message: `${operation} answer could not be read` }
      : { kind: 'found', data }
  }

  async function write<T>(
    operation: string,
    name: string,
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    pick: (body: unknown) => T,
  ): Promise<SslWrite<T>> {
    const { verdict, body: answer } = await call(operation, name, method, path, body)
    if (verdict.outcome === 'ok') return { kind: 'ok', data: pick(answer) }
    if (verdict.outcome === 'rejected') {
      return { kind: 'rejected', code: verdict.code, message: verdict.message }
    }
    if (verdict.outcome === 'not_found') {
      return { kind: 'rejected', code: 'CERTIFICATE_NOT_FOUND', message: verdict.message }
    }
    return unsettled(verdict)
  }

  const q = (value: string) => encodeURIComponent(value)
  const statusOf = (body: unknown) => str((body as { status?: unknown } | null)?.status)

  return {
    status: (name) =>
      read('SslCheckStatus', name, 'PUT', '/ssls/check-status', { domainName: name }, (body) => {
        const raw = (body ?? {}) as Record<string, unknown>
        if (typeof raw.status !== 'string') return null
        return {
          domainName: str(raw.domainName) || name,
          status: raw.status,
          isConfigured: bool(raw.isConfigured),
          isIssued: bool(raw.isIssued),
          certificateExpiresAt: sslDate(raw.certificateExpiresAt),
        }
      }),

    details: (name) =>
      read(
        'SslGetCertificate',
        name,
        'GET',
        `/ssls/certificate?DomainName=${q(name)}`,
        undefined,
        (body) => {
          const raw = (body ?? {}) as Record<string, unknown>
          if (typeof raw.status !== 'string') return null
          const subscription = (raw.subscription ?? {}) as Record<string, unknown>
          const certificate = (raw.certificate ?? {}) as Record<string, unknown>
          return {
            status: raw.status,
            packageCode: str(raw.packageCode) || null,
            isConfigured: bool(raw.isConfigured),
            isIssued: bool(raw.isIssued),
            purchasedAt: sslDate(subscription.purchasedAt),
            subscriptionEndsAt: sslDate(subscription.expiresAt),
            issuedAt: sslDate(certificate.issuedAt),
            validUntil: sslDate(certificate.validUntil),
          }
        },
      ),

    content: (name) =>
      read(
        'SslGetCertificateContent',
        name,
        'GET',
        `/ssls/certificate-content?DomainName=${q(name)}`,
        undefined,
        (body) => {
          const raw = (body ?? {}) as Record<string, unknown>
          // A certificate is public; anything else in the answer is not kept.
          const pem = (value: unknown) => {
            const text = str(value).replace(/\r\n?/g, '\n').trim()
            return /PRIVATE KEY/.test(text) ? '' : text
          }
          return {
            certificate: pem(raw.certificate),
            intermediates: [
              pem(raw.intermediateCertificate1),
              pem(raw.intermediateCertificate2),
            ].filter(Boolean),
            root: pem(raw.rootCertificate),
          }
        },
      ),

    approvers: (name, productCode) =>
      read(
        'SslApprovers',
        name,
        'GET',
        `/ssls/approvers?DomainName=${q(name)}&PackageCode=${q(productCode)}`,
        undefined,
        (body) => {
          const mails = (body as { mails?: unknown } | null)?.mails
          if (!Array.isArray(mails)) return null
          return [
            ...new Set(
              mails
                .filter((mail): mail is string => typeof mail === 'string' && mail.includes('@'))
                .map((mail) => mail.trim().toLowerCase()),
            ),
          ]
        },
      ),

    checkCsr: (csr) =>
      read('SslCheckCsr', null, 'POST', '/ssls/check-csr', { csr }, (body) => {
        const raw = (body ?? {}) as Record<string, unknown>
        if (typeof raw.domainName !== 'string' || raw.domainName === '') return null
        return {
          commonName: raw.domainName.toLowerCase(),
          alternativeNames: str(raw.alternativeNames)
            .split(/[,\s]+/)
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
          isWildcard: bool(raw.isWildcard),
          organization: str(raw.organization) || null,
          country: str(raw.country) || null,
        }
      }),

    generateCsr: (input) =>
      // Recorded as an outcome only: the answer carries the private key.
      read(
        'SslGenerateCsr',
        input.name,
        'POST',
        '/ssls/generate-csr',
        {
          domainName: input.name,
          country: input.country,
          state: input.state,
          locality: input.locality,
          organization: input.organization,
          organizationUnit: input.organizationUnit,
          ...(input.alternativeNames.length > 0
            ? { alternativeNames: [...input.alternativeNames] }
            : {}),
        },
        (body) => {
          const raw = (body ?? {}) as Record<string, unknown>
          const csr = str(raw.csr).replace(/\r\n?/g, '\n').trim()
          const privateKey = str(raw.privateKey).replace(/\r\n?/g, '\n').trim()
          return csr.includes('CERTIFICATE REQUEST') && privateKey.includes('PRIVATE KEY')
            ? { csr, privateKey }
            : null
        },
      ),

    initialize: (productCode, name) =>
      write(
        'SslInitialize',
        name,
        'POST',
        '/ssls/initialize',
        { packageCode: productCode, domainName: name },
        (body) => {
          const raw = (body ?? {}) as Record<string, unknown>
          const id = str(raw.certificateId)
          return {
            certificateId: /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null,
            status: str(raw.status),
          }
        },
      ),

    configure: (input) =>
      write(
        'SslConfigure',
        input.name,
        'PUT',
        '/ssls/configure',
        {
          domainName: input.name,
          csr: input.csr,
          // Never a private key: the supplier does not need one (sandbox, 2 Oct 2026).
          approverMail: input.approverEmail,
          authenticationType: 'EMAIL',
          webServerType: input.webServer,
          sanList: input.extraNames.join(','),
          wildcardList: '',
          contact: input.contact,
        },
        (body) => ({ status: statusOf(body) }),
      ),

    reissue: (name, approverEmail) =>
      write(
        'SslReissue',
        name,
        'POST',
        '/ssls/reissue',
        { domainName: name, ...(approverEmail ? { approverMail: approverEmail } : {}) },
        (body) => ({ status: statusOf(body) }),
      ),
  }
}
