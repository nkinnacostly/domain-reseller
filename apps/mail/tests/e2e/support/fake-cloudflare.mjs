/**
 * A fake Cloudflare API (client/v4), in memory, for "Add to Cloudflare"
 * (MAIL-SPEC §5.3): the unit tests answer through MSW with it, and the e2e
 * mock server (mock-ses.mjs) serves it over HTTP. It answers the calls
 * apps/mail makes — zones by name, DNS records by name, create, unproxy, and
 * Domain Connect's template check — in the shapes and error codes of
 * Cloudflare's API v4 (an unknown token is 403 with 9109 "Invalid access
 * token", seen on 8 Oct 2026). A record it creates is published to the fake
 * DNS it is given, so the page's live check sees it. No test reaches
 * Cloudflare. Making one starts nothing.
 */

const TEMPLATE_PATH =
  '/client/v4/dns/domainconnect/v2/domainTemplates/providers/mydomainshub.com/services/mail'

/**
 * @param {{ dns?: { publish: (host: string, type: string, data: string) => void } }} [options]
 */
export function createFakeCloudflare({ dns } = {}) {
  /** @type {Map<string, { id: string, name: string, records: any[] }>} */ const zones = new Map()
  /** @type {Map<string, { zones: Set<string>, dnsEdit: boolean }>} */ const tokens = new Map()
  /** @type {{ method: string, path: string, authorization: string, body: any }[]} */ const calls =
    []
  const state = { templateSupported: false, failFrom: Number.POSITIVE_INFINITY, made: 0 }

  const ok = (/** @type {any} */ result, status = 200) => ({
    status,
    body: { success: true, errors: [], messages: [], result },
  })
  const error = (
    /** @type {number} */ status,
    /** @type {number} */ code,
    /** @type {string} */ message,
  ) => ({
    status,
    body: { success: false, errors: [{ code, message }], messages: [], result: null },
  })
  const host = (/** @type {string} */ value) => value.trim().toLowerCase().replace(/\.+$/, '')

  /** A zone the fake holds, and the DNS that says it is on Cloudflare. */
  function addZone(/** @type {string} */ name) {
    const zone = { id: `${zones.size + 1}`.padStart(32, 'a'), name: host(name), records: [] }
    zones.set(zone.name, zone)
    dns?.publish(zone.name, 'NS', 'kelly.ns.cloudflare.com.')
    dns?.publish(zone.name, 'NS', 'steven.ns.cloudflare.com.')
    return zone
  }

  /** A token that reaches these zones; `dnsEdit: false` has Zone Read only. */
  function addToken(
    /** @type {string} */ token,
    /** @type {string[]} */ names,
    { dnsEdit = true } = {},
  ) {
    tokens.set(token, { zones: new Set(names.map(host)), dnsEdit })
  }

  /** A record already in a zone, as the customer made it. */
  function addRecord(/** @type {string} */ zoneName, /** @type {any} */ record) {
    const zone = zones.get(host(zoneName))
    if (!zone) throw new Error(`no zone ${zoneName}`)
    const made = { id: `${++state.made}`.padStart(32, 'f'), proxied: false, ...record }
    zone.records.push(made)
    publishRecord(made)
    return made
  }

  function publishRecord(/** @type {any} */ record) {
    if (!dns) return
    if (record.type === 'CNAME' && !record.proxied)
      dns.publish(host(record.name), 'CNAME', `${record.content}.`)
    if (record.type === 'MX')
      dns.publish(host(record.name), 'MX', `${record.priority ?? 10} ${record.content}.`)
    if (record.type === 'TXT') dns.publish(host(record.name), 'TXT', record.content)
  }

  /**
   * One API call. `path` is the URL's path, `query` its search params.
   * @param {string} method
   * @param {string} path
   * @param {URLSearchParams} query
   * @param {any} body
   * @param {string} authorization
   */
  function handle(method, path, query, body, authorization) {
    calls.push({ method, path, authorization, body })
    if (method === 'GET' && path === TEMPLATE_PATH) {
      return state.templateSupported ? ok({ version: 1 }) : error(404, 1000, 'not found')
    }
    if (calls.length > state.failFrom) return error(503, 10000, 'service unavailable')
    const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization ?? '')
    if (!bearer) return error(400, 6003, 'Invalid request headers')
    const token = tokens.get(bearer[1] ?? '')
    if (!token) return error(403, 9109, 'Invalid access token')

    const parts = path.replace(/^\/client\/v4\//, '').split('/')
    if (parts[0] !== 'zones') return error(404, 7003, 'Could not route')
    if (parts.length === 1 && method === 'GET') {
      const name = host(query.get('name') ?? '')
      const zone = zones.get(name)
      return ok(
        zone && token.zones.has(zone.name)
          ? [{ id: zone.id, name: zone.name, status: 'active' }]
          : [],
      )
    }
    const zone = [...zones.values()].find((z) => z.id === parts[1])
    if (!zone || !token.zones.has(zone.name)) {
      return error(403, 9109, 'Unauthorized to access requested resource')
    }
    if (parts[2] !== 'dns_records') return error(404, 7003, 'Could not route')

    if (parts.length === 3 && method === 'GET') {
      const name = host(query.get('name') ?? '')
      return ok(zone.records.filter((r) => host(r.name) === name))
    }
    if (!token.dnsEdit) return error(403, 10000, 'Authentication error')
    if (parts.length === 3 && method === 'POST') {
      const onName = zone.records.filter((r) => host(r.name) === host(body?.name ?? ''))
      if (onName.some((r) => r.type === body.type && r.content === body.content)) {
        return error(400, 81058, 'An identical record already exists.')
      }
      if (body.type === 'CNAME' ? onName.length > 0 : onName.some((r) => r.type === 'CNAME')) {
        return error(400, 81053, 'An A, AAAA, or CNAME record with that host already exists.')
      }
      const record = { id: `${++state.made}`.padStart(32, 'f'), proxied: false, ...body }
      zone.records.push(record)
      publishRecord(record)
      return ok(record)
    }
    if (parts.length === 4 && method === 'PATCH') {
      const record = zone.records.find((r) => r.id === parts[3])
      if (!record) return error(404, 81044, 'Record does not exist.')
      Object.assign(record, body)
      publishRecord(record)
      return ok(record)
    }
    return error(404, 7003, 'Could not route')
  }

  return {
    zones,
    tokens,
    calls,
    state,
    addZone,
    addToken,
    addRecord,
    handle,
    /** Domain Connect: Cloudflare has taken on our template. */
    supportTemplate(on = true) {
      state.templateSupported = on
    },
    /** Every call after the first `n` answers 503, as an outage would. */
    failAfter(/** @type {number} */ n) {
      state.failFrom = n
    },
  }
}
