/**
 * A fake Amazon SES (API v2) and a fake public DNS, in memory, for Mail's
 * tests: the unit tests answer through MSW with it, and the e2e mock server
 * (mock-ses.mjs) serves it over HTTP. It answers the management calls
 * apps/mail makes (MAIL-SPEC §4.1, §5) in the shapes of the SES API v2
 * reference, with AWS's error types. No test ever reaches AWS or a real
 * resolver (§12, N12 for email). It holds no side effects of its own: making
 * one starts nothing.
 */

const ACCOUNT = '111122223333'
const BASE = '/v2/email/'

/** @param {number} n */
function token(n) {
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += letters[(n * 7 + i * 13) % letters.length]
  return out
}

/**
 * @param {{ region?: string }} [options]
 */
export function createFakeSes({ region = 'eu-west-2' } = {}) {
  /** @type {Map<string, any>} */ const tenants = new Map()
  /** @type {Map<string, Map<string, any>>} */ const sets = new Map()
  /** @type {Map<string, any>} */ const identities = new Map()
  /** @type {Map<string, Set<string>>} */ const resources = new Map()
  /** @type {Map<string, string>} */ const policies = new Map()
  /** @type {Map<string, Map<string, string[]>>} */ const dns = new Map()
  /** @type {{ method: string, path: string, body: any }[]} */ const calls = []
  /** @type {{ method: string, prefix: string, status: number, errorType?: string, times: number }[]} */
  const failures = []
  let made = 0

  const arn = {
    tenant: (/** @type {string} */ name, /** @type {string} */ id) =>
      `arn:aws:ses:${region}:${ACCOUNT}:tenant/${name}/${id}`,
    identity: (/** @type {string} */ name) => `arn:aws:ses:${region}:${ACCOUNT}:identity/${name}`,
    set: (/** @type {string} */ name) =>
      `arn:aws:ses:${region}:${ACCOUNT}:configuration-set/${name}`,
  }
  const answer = (
    /** @type {number} */ status,
    /** @type {any} */ body = {},
    /** @type {string | undefined} */ errorType = undefined,
  ) => ({
    status,
    body,
    errorType,
  })
  const notFound = () => answer(404, { message: 'not found' }, 'NotFoundException')
  const exists = () => answer(400, { message: 'already exists' }, 'AlreadyExistsException')
  const bad = () => answer(400, { message: 'bad request' }, 'BadRequestException')

  /** @param {string} type @param {string} arnValue */
  function typeOf(type, arnValue) {
    if (type) return type
    if (arnValue.includes(':identity/')) return 'EMAIL_IDENTITY'
    if (arnValue.includes(':configuration-set/')) return 'CONFIGURATION_SET'
    return 'EMAIL_TEMPLATE'
  }

  /**
   * One SES call. `path` is the URL's path (still encoded), from `/v2/email/`.
   * @param {string} method
   * @param {string} path
   * @param {any} body
   */
  function handle(method, path, body) {
    const rest = path.startsWith(BASE) ? path.slice(BASE.length) : path
    const parts = rest
      .split('/')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s))
    calls.push({ method, path: `/${parts.join('/')}`, body })
    const failure = failures.find(
      (f) => f.method === method && `/${parts.join('/')}`.startsWith(f.prefix),
    )
    if (failure) {
      failure.times -= 1
      if (failure.times <= 0) failures.splice(failures.indexOf(failure), 1)
      return answer(failure.status, { message: 'injected' }, failure.errorType)
    }
    const [head, a, b, c] = parts

    if (head === 'tenants' && method === 'POST' && a === undefined) {
      if (tenants.has(body.TenantName)) return exists()
      made += 1
      const id = `tn-${made}`
      const tenant = {
        TenantName: body.TenantName,
        TenantId: id,
        TenantArn: arn.tenant(body.TenantName, id),
        SendingStatus: 'ENABLED',
        ...(body.SuppressionAttributes
          ? { SuppressionAttributes: body.SuppressionAttributes }
          : {}),
      }
      tenants.set(body.TenantName, tenant)
      resources.set(body.TenantName, new Set())
      return answer(200, tenant)
    }
    if (head === 'tenants' && a === 'get' && method === 'POST') {
      const tenant = tenants.get(body.TenantName)
      return tenant ? answer(200, { Tenant: tenant }) : notFound()
    }
    if (head === 'tenant' && a === 'suppression' && method === 'POST') {
      const tenant = tenants.get(body.TenantName)
      if (!tenant) return notFound()
      tenant.SuppressionAttributes = {
        SuppressionScope: body.SuppressionScope,
        SuppressedReasons: body.SuppressedReasons,
      }
      return answer(200)
    }
    if (head === 'tenants' && a === 'resources' && method === 'POST') {
      const held = resources.get(body.TenantName)
      if (b === 'list') {
        if (!held) return notFound()
        // As SES did on 8 Oct 2026: a Filter of RESOURCE_TYPE is a BadRequestException.
        if (body.Filter !== undefined) return bad()
        return answer(200, {
          TenantResources: [...held].map((r) => ({ ResourceArn: r, ResourceType: typeOf('', r) })),
        })
      }
      if (!held) return notFound()
      if (b === 'delete') {
        if (!held.has(body.ResourceArn)) return notFound()
        held.delete(body.ResourceArn)
        return answer(200)
      }
      if (b === undefined) {
        if (held.has(body.ResourceArn)) return exists()
        held.add(body.ResourceArn)
        return answer(200)
      }
    }
    if (head === 'configuration-sets') {
      if (method === 'POST' && a === undefined) {
        if (sets.has(body.ConfigurationSetName)) return exists()
        sets.set(body.ConfigurationSetName, new Map())
        return answer(200)
      }
      const set = sets.get(a)
      if (!set) return notFound()
      if (method === 'GET' && b === undefined) return answer(200, { ConfigurationSetName: a })
      if (b === 'event-destinations') {
        if (method === 'GET') {
          return answer(200, {
            EventDestinations: [...set.entries()].map(([name, d]) => ({ Name: name, ...d })),
          })
        }
        if (method === 'POST') {
          if (set.has(body.EventDestinationName)) return exists()
          set.set(body.EventDestinationName, body.EventDestination)
          return answer(200)
        }
        if (method === 'PUT' && c) {
          if (!set.has(c)) return notFound()
          set.set(c, body.EventDestination)
          return answer(200)
        }
      }
    }
    if (head === 'identities') {
      if (method === 'POST' && a === undefined) {
        if (identities.has(body.EmailIdentity)) return exists()
        made += 1
        const identity = {
          IdentityType: 'DOMAIN',
          VerificationStatus: 'PENDING',
          VerifiedForSendingStatus: false,
          DkimAttributes: {
            SigningEnabled: true,
            Status: 'PENDING',
            Tokens: [token(made), token(made + 1), token(made + 2)],
            NextSigningKeyLength: body.DkimSigningAttributes?.NextSigningKeyLength,
          },
          MailFromAttributes: {},
          ...(body.ConfigurationSetName ? { ConfigurationSetName: body.ConfigurationSetName } : {}),
        }
        identities.set(body.EmailIdentity, identity)
        return answer(200, {
          IdentityType: 'DOMAIN',
          VerifiedForSendingStatus: false,
          DkimAttributes: identity.DkimAttributes,
        })
      }
      const identity = identities.get(a)
      if (!identity) return notFound()
      if (method === 'GET' && b === undefined) return answer(200, identity)
      if (method === 'DELETE' && b === undefined) {
        const held = [...resources.values()].some((set) => set.has(arn.identity(a)))
        if (held) return bad()
        identities.delete(a)
        return answer(200)
      }
      if (method === 'PUT' && b === 'mail-from') {
        identity.MailFromAttributes = {
          MailFromDomain: body.MailFromDomain,
          MailFromDomainStatus: 'PENDING',
          BehaviorOnMxFailure: body.BehaviorOnMxFailure,
        }
        return answer(200)
      }
      if (method === 'PUT' && b === 'configuration-set') {
        identity.ConfigurationSetName = body.ConfigurationSetName
        return answer(200)
      }
    }
    if (head === 'reputation' && a === 'entities' && b === 'RESOURCE' && c) {
      const known = [...tenants.values()].some((t) => t.TenantArn === c)
      if (!known) return notFound()
      if (method === 'GET' && parts[4] === undefined) {
        return answer(200, {
          ReputationEntity: {
            ReputationEntityReference: c,
            ReputationEntityType: 'RESOURCE',
            ReputationManagementPolicy:
              policies.get(c) ?? `arn:aws:ses:${region}:aws:reputation-policy/standard`,
            CustomerManagedStatus: { Status: 'ENABLED' },
            AwsSesManagedStatus: { Status: 'ENABLED' },
            SendingStatusAggregate: 'ENABLED',
          },
        })
      }
      if (method === 'PUT' && parts[4] === 'policy') {
        policies.set(c, body.ReputationEntityPolicy)
        return answer(200)
      }
    }
    return answer(404, { message: `the fake SES has no ${method} ${path}` }, 'NotFoundException')
  }

  /** @param {string} name */
  function records(name) {
    const identity = identities.get(name)
    if (!identity) return []
    return /** @type {string[]} */ (identity.DkimAttributes.Tokens).map(
      (t) =>
        /** @type {[string, string]} */ ([`${t}._domainkey.${name}`, `${t}.dkim.amazonses.com`]),
    )
  }

  /**
   * A DNS-over-HTTPS answer in the JSON form Cloudflare and Google serve.
   * @param {string} name
   * @param {string} type
   */
  function resolve(name, type) {
    const host = name.toLowerCase().replace(/\.+$/, '')
    const zone = dns.get(host)
    const kind = /^\d+$/.test(type)
      ? { 2: 'NS', 5: 'CNAME', 15: 'MX', 16: 'TXT' }[Number(type)]
      : type
    if (!zone) return { Status: 3, Answer: [] }
    const code = { NS: 2, CNAME: 5, MX: 15, TXT: 16 }[kind ?? ''] ?? 0
    return {
      Status: 0,
      Answer: (zone.get(kind ?? '') ?? []).map((data) => ({
        name: `${host}.`,
        type: code,
        TTL: 300,
        data,
      })),
    }
  }

  /** @param {string} host @param {string} type @param {string} data */
  function publish(host, type, data) {
    const zone = dns.get(host) ?? new Map()
    zone.set(type, [...(zone.get(type) ?? []), data])
    dns.set(host, zone)
  }

  return {
    region,
    account: ACCOUNT,
    calls,
    tenants,
    sets,
    identities,
    resources,
    policies,
    handle,
    resolve,
    /** Every record a domain's page asks for, published as asked. */
    publishRecords(/** @type {string} */ name) {
      for (const [host, target] of records(name)) publish(host, 'CNAME', `${target}.`)
      const mailFrom = identities.get(name)?.MailFromAttributes?.MailFromDomain ?? `send.${name}`
      publish(mailFrom, 'MX', `10 feedback-smtp.${region}.amazonses.com.`)
      publish(mailFrom, 'TXT', '"v=spf1 include:amazonses.com ~all"')
    },
    publish,
    /** SES has seen the DKIM records: verified for sending. */
    verify(/** @type {string} */ name) {
      const identity = identities.get(name)
      if (!identity) return false
      identity.VerificationStatus = 'SUCCESS'
      identity.VerifiedForSendingStatus = true
      identity.DkimAttributes.Status = 'SUCCESS'
      if (identity.MailFromAttributes.MailFromDomain)
        identity.MailFromAttributes.MailFromDomainStatus = 'SUCCESS'
      return true
    },
    /** SES gave up on the identity. */
    fail(/** @type {string} */ name) {
      const identity = identities.get(name)
      if (!identity) return false
      identity.VerificationStatus = 'FAILED'
      identity.VerifiedForSendingStatus = false
      identity.DkimAttributes.Status = 'FAILED'
      return true
    },
    /** The next `times` calls with this method whose path starts with `prefix` fail. */
    failNext(
      /** @type {string} */ method,
      /** @type {string} */ prefix,
      status = 503,
      /** @type {string | undefined} */ errorType = undefined,
      times = 1,
    ) {
      failures.push({ method, prefix, status, errorType, times })
    },
    arn,
  }
}
