import { txtText } from './dns-check'
import type { DnsRecord } from './records'

/**
 * Adding a domain's records to its Cloudflare zone with a token the customer
 * pastes once (MAIL-SPEC §5.3). The token is used for this one run and kept
 * nowhere: not stored, not logged, not returned.
 *
 * Nothing the customer already has is changed or removed. Each record is
 * looked up by name first: the same record is left as it is ("present"), a
 * DMARC policy of theirs is theirs to keep ("kept_yours"), and anything else
 * on the name — another MX, another SPF, a CNAME — is reported for them to
 * decide ("conflict"), never overwritten. The one change made to an existing
 * record: a DKIM CNAME proxied through Cloudflare (the orange cloud) cannot
 * be read by mailboxes, so it is set to DNS only ("updated").
 *
 * Calls, from Cloudflare's API v4 reference: GET /zones?name= (Zone Read),
 * GET and POST /zones/:id/dns_records, PATCH /zones/:id/dns_records/:id
 * (DNS Edit). The token page we link to asks for exactly those two.
 */

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'

/**
 * Cloudflare's token page with the two permissions filled in (Cloudflare's
 * "API token template URLs"); the customer picks the zone and creates it.
 */
export function cloudflareTokenPage(): string {
  const permissions = JSON.stringify([
    { key: 'dns', type: 'edit' },
    { key: 'zone', type: 'read' },
  ])
  const query = new URLSearchParams({
    permissionGroupKeys: permissions,
    accountId: '*',
    zoneId: 'all',
    name: 'MyDomainsHub Mail DNS',
  })
  return `https://dash.cloudflare.com/profile/api-tokens?${query.toString()}`
}

/** Cloudflare's tokens are 40 URL-safe characters today; leave room for a longer form. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{30,200}$/

export type RecordOutcome = 'added' | 'present' | 'updated' | 'kept_yours' | 'conflict' | 'failed'

export type RecordResult = { id: string; outcome: RecordOutcome; seen: string[] }

export type CloudflareFailure = 'bad_token' | 'not_allowed' | 'no_zone' | 'unreachable'

export type CloudflareAnswer =
  | {
      ok: true
      zone: string
      results: RecordResult[]
      /** Set when Cloudflare stopped answering part-way: the rest are `failed`. */
      stopped?: CloudflareFailure
    }
  | { ok: false; code: CloudflareFailure }

type CfRecord = {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
  priority?: number
}

type CfError = { code?: number; message?: string }

class Refused extends Error {
  constructor(readonly code: CloudflareFailure) {
    super(code)
  }
}

// Seen from api.cloudflare.com on 8 Oct 2026: an unknown token is 403 with
// 9109 "Invalid access token"; a malformed one 400 with 6003 / 6111.
const BAD_TOKEN_CODES = new Set([6003, 6111, 9106])
// Cloudflare's ids are 32 hex characters; anything else never goes into a path.
const CF_ID = /^[A-Za-z0-9]{1,64}$/
const DUPLICATE_CODES = new Set([81053, 81057, 81058])

const host = (value: string) => value.trim().toLowerCase().replace(/\.+$/, '')
const squash = (value: string) =>
  txtText(value).trim().replace(/\s+/g, ' ').replace(/;\s*$/, '').toLowerCase()

/** The zones a name could be in, longest first: mail.example.com, then example.com. */
export function zoneCandidates(name: string): string[] {
  const labels = host(name).split('.')
  const out: string[] = []
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'))
  return out
}

/** What to do with one record, given what the zone already has on its name. */
export function decide(
  record: DnsRecord,
  existing: readonly CfRecord[],
):
  | { action: 'create' }
  | { action: 'none'; outcome: RecordOutcome; seen: string[] }
  | {
      action: 'unproxy'
      recordId: string
    } {
  const onName = existing.filter((item) => host(item.name) === host(record.name))
  const describe = (items: readonly CfRecord[]) =>
    items.map((item) =>
      item.type === 'TXT'
        ? txtText(item.content)
        : `${item.type} ${item.priority !== undefined && item.type === 'MX' ? `${item.priority} ` : ''}${host(item.content)}`,
    )

  switch (record.type) {
    case 'CNAME': {
      const same = onName.find(
        (item) => item.type === 'CNAME' && host(item.content) === host(record.value),
      )
      if (same) {
        return same.proxied ? { action: 'unproxy', recordId: same.id } : none('present')
      }
      // A CNAME cannot share its name with any other record.
      return onName.length > 0 ? none('conflict', describe(onName)) : { action: 'create' }
    }
    case 'MX': {
      const cname = onName.filter((item) => item.type === 'CNAME')
      if (cname.length > 0) return none('conflict', describe(cname))
      const mx = onName.filter((item) => item.type === 'MX')
      if (mx.some((item) => host(item.content) === host(record.value))) return none('present')
      // Another MX here would take some of the bounces: theirs to decide.
      return mx.length > 0 ? none('conflict', describe(mx)) : { action: 'create' }
    }
    case 'TXT': {
      const cname = onName.filter((item) => item.type === 'CNAME')
      const txt = onName.filter((item) => item.type === 'TXT')
      if (record.purpose === 'dmarc') {
        if (txt.some((item) => squash(item.content) === squash(record.value)))
          return none('present')
        const theirs = [
          ...cname,
          ...txt.filter((item) => /^v=dmarc1(;|\s|$)/i.test(txtText(item.content).trim())),
        ]
        return theirs.length > 0 ? none('kept_yours', describe(theirs)) : { action: 'create' }
      }
      if (cname.length > 0) return none('conflict', describe(cname))
      const spf = txt.filter((item) => /^v=spf1(\s|$)/i.test(txtText(item.content).trim()))
      if (spf.some((item) => squash(item.content) === squash(record.value))) return none('present')
      // Two SPF records on one name make SPF fail for both.
      return spf.length > 0 ? none('conflict', describe(spf)) : { action: 'create' }
    }
  }
}

function none(outcome: RecordOutcome, seen: string[] = []) {
  return { action: 'none' as const, outcome, seen }
}

/** The body Cloudflare wants for one of our records. */
export function recordBody(record: DnsRecord): Record<string, unknown> {
  const base = { type: record.type, name: record.name, ttl: 1, comment: 'MyDomainsHub Mail' }
  switch (record.type) {
    case 'CNAME':
      // DNS only: a proxied DKIM record cannot be read by mailboxes.
      return { ...base, content: record.value, proxied: false }
    case 'MX':
      return { ...base, content: record.value, priority: record.priority ?? 10 }
    case 'TXT':
      // Quoted, as Cloudflare's API asks of TXT content.
      return { ...base, content: `"${record.value}"` }
  }
}

export async function addCloudflareRecords({
  token,
  domain,
  records,
  apiBase = CLOUDFLARE_API,
  fetchImpl = fetch,
  timeoutMs = 8_000,
}: {
  token: string
  /** The sending domain; its zone is it or the nearest parent Cloudflare holds. */
  domain: string
  records: readonly DnsRecord[]
  apiBase?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<CloudflareAnswer> {
  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; result: unknown; errors: CfError[] }> {
    let response: Response
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      })
    } catch {
      throw new Refused('unreachable')
    }
    let json: { result?: unknown; errors?: CfError[] } = {}
    try {
      json = (await response.json()) as typeof json
    } catch {
      // A body we cannot read is judged by the status alone.
    }
    const errors = Array.isArray(json.errors) ? json.errors : []
    const invalid = errors.some(
      (e) =>
        BAD_TOKEN_CODES.has(e.code ?? 0) ||
        (e.code === 9109 && /invalid access token/i.test(e.message ?? '')),
    )
    if (response.status === 401 || invalid) throw new Refused('bad_token')
    if (response.status === 403) throw new Refused('not_allowed')
    if (response.status >= 500 || response.status === 429) throw new Refused('unreachable')
    return { status: response.status, result: json.result, errors }
  }

  async function settle(zoneId: string, record: DnsRecord): Promise<RecordResult> {
    const listed = await call(
      'GET',
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(record.name)}&per_page=100`,
    )
    const existing = (Array.isArray(listed.result) ? listed.result : []).filter(
      (item): item is CfRecord =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as CfRecord).id === 'string' &&
        CF_ID.test((item as CfRecord).id) &&
        typeof (item as CfRecord).type === 'string' &&
        typeof (item as CfRecord).name === 'string' &&
        typeof (item as CfRecord).content === 'string',
    )
    const plan = decide(record, existing)
    if (plan.action === 'none') return { id: record.id, outcome: plan.outcome, seen: plan.seen }
    const answer =
      plan.action === 'unproxy'
        ? await call('PATCH', `/zones/${zoneId}/dns_records/${plan.recordId}`, { proxied: false })
        : await call('POST', `/zones/${zoneId}/dns_records`, recordBody(record))
    if (answer.status >= 200 && answer.status < 300) {
      return { id: record.id, outcome: plan.action === 'unproxy' ? 'updated' : 'added', seen: [] }
    }
    const duplicate = answer.errors.some((e) => DUPLICATE_CODES.has(e.code ?? 0))
    return { id: record.id, outcome: duplicate ? 'present' : 'failed', seen: [] }
  }

  try {
    let zone: { id: string; name: string } | null = null
    for (const candidate of zoneCandidates(domain)) {
      const { result } = await call('GET', `/zones?name=${encodeURIComponent(candidate)}`)
      const first = Array.isArray(result) ? (result[0] as { id?: unknown; name?: unknown }) : null
      if (
        first &&
        typeof first.id === 'string' &&
        CF_ID.test(first.id) &&
        typeof first.name === 'string'
      ) {
        zone = { id: first.id, name: first.name }
        break
      }
    }
    if (!zone) return { ok: false, code: 'no_zone' }

    const results: RecordResult[] = []
    for (const [index, record] of records.entries()) {
      try {
        results.push(await settle(zone.id, record))
      } catch (error) {
        if (!(error instanceof Refused)) throw error
        // Refused before anything changed: say so plainly, nothing was done.
        if (!results.some((r) => r.outcome === 'added' || r.outcome === 'updated')) {
          return { ok: false, code: error.code }
        }
        for (const rest of records.slice(index)) {
          results.push({ id: rest.id, outcome: 'failed', seen: [] })
        }
        return { ok: true, zone: zone.name, results, stopped: error.code }
      }
    }
    return { ok: true, zone: zone.name, results }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, code: error.code }
    throw error
  }
}
