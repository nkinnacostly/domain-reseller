import {
  assertSesCredentials,
  type SesAnswer,
  type SesCredentials,
  sesCall,
  sesPath,
} from './request'
import { uriEncode } from './sigv4'

/**
 * The SES API v2 management calls Mail makes (MAIL-SPEC §4.1, §5, §7.4),
 * signed with our own SigV4 — no AWS SDK. Used by apps/mail with the
 * `mdm-manager` key, which may manage identities, tenants, configuration sets
 * and reputation but is denied every send (§4.3); the worker's key may send
 * and read the account's quota (`getAccount`), nothing else.
 *
 * Every call answers `{ ok: true, … }` with the fields we use, or SES's
 * status and error type (`SesFailure`) — never SES's message text, which can
 * quote an address (N13).
 */

export type SesFailure = Extract<SesAnswer, { ok: false }>
export type SesResult<T extends object = object> = ({ ok: true } & T) | SesFailure

/** §4.2: what each account's configuration set publishes to SNS. No opens or clicks in v1. */
export const MAIL_EVENT_TYPES = [
  'SEND',
  'DELIVERY',
  'BOUNCE',
  'COMPLAINT',
  'REJECT',
  'DELIVERY_DELAY',
  'RENDERING_FAILURE',
] as const

export type ReputationPolicy = 'strict' | 'standard' | 'none'
export type CustomerManagedStatus = 'ENABLED' | 'DISABLED' | 'REINSTATED'

/** §4.2: the one event destination each account's configuration set has. */
export const MAIL_EVENT_DESTINATION = 'mail-ses-events'

export type TenantResourceType = 'EMAIL_IDENTITY' | 'CONFIGURATION_SET' | 'EMAIL_TEMPLATE'

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
const NAME = /^[A-Za-z0-9_-]{1,64}$/
const ARN = /^arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:\S+$/
const ACCOUNT_ID = /^\d{12}$/

/** The AWS account an ARN belongs to (`arn:aws:sns:eu-west-2:123456789012:…`), or null. */
export function awsAccountOf(arn: string): string | null {
  const account = arn.split(':')[4]
  return ARN.test(arn) && account !== undefined && ACCOUNT_ID.test(account) ? account : null
}

/**
 * SES gives no ARN for an identity or a configuration set; a tenant
 * association needs one. Built as the SES developer guide writes them:
 * `arn:aws:ses:<region>:<account>:identity/<domain>` and `…:configuration-set/<name>`.
 */
export function sesResourceArn(
  region: string,
  account: string,
  kind: 'identity' | 'configuration-set',
  name: string,
): string {
  check(ACCOUNT_ID.test(account), 'the AWS account')
  check(kind === 'identity' ? DOMAIN.test(name) : NAME.test(name), `the ${kind} name`)
  return `arn:aws:ses:${region}:${account}:${kind}/${name}`
}

/** A tenant resource's type from its ARN, for an answer that leaves ResourceType out. */
function resourceTypeOf(arn: string): TenantResourceType | null {
  if (arn.includes(':configuration-set/')) return 'CONFIGURATION_SET'
  if (arn.includes(':identity/')) return 'EMAIL_IDENTITY'
  if (arn.includes(':template/')) return 'EMAIL_TEMPLATE'
  return null
}

/** SES's own reputation policies (developer guide, Tenants). */
export const reputationPolicyArn = (region: string, policy: ReputationPolicy): string =>
  `arn:aws:ses:${region}:aws:reputation-policy/${policy}`

/** SES answered that the thing is not there (404, NotFoundException). */
export const isSesNotFound = (answer: SesResult): boolean =>
  !answer.ok && (answer.status === 404 || answer.code === 'NotFoundException')

/** SES answered that it is there already (AlreadyExistsException). */
export const isSesAlreadyThere = (answer: SesResult): boolean =>
  !answer.ok && answer.code === 'AlreadyExistsException'
/** One address, as it was sent: SES keeps a suppressed address's case. */
const ADDRESS = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`SES: ${what} is not valid`)
}

type Fields = Record<string, unknown>
const asRecord = (value: unknown): Fields =>
  value && typeof value === 'object' ? (value as Fields) : {}
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export type IdentityState = {
  /** PENDING, SUCCESS, FAILED, TEMPORARY_FAILURE or NOT_STARTED. */
  verificationStatus: string | null
  verifiedForSending: boolean
  dkimStatus: string | null
  dkimTokens: string[]
  mailFromDomain: string | null
  /** PENDING, SUCCESS, FAILED or TEMPORARY_FAILURE. */
  mailFromStatus: string | null
  configurationSetName: string | null
}

function identityState(json: unknown): IdentityState {
  const body = asRecord(json)
  const dkim = asRecord(body.DkimAttributes)
  const mailFrom = asRecord(body.MailFromAttributes)
  return {
    verificationStatus: asString(body.VerificationStatus),
    verifiedForSending: body.VerifiedForSendingStatus === true,
    dkimStatus: asString(dkim.Status),
    dkimTokens: Array.isArray(dkim.Tokens)
      ? dkim.Tokens.filter((t): t is string => typeof t === 'string')
      : [],
    mailFromDomain: asString(mailFrom.MailFromDomain),
    mailFromStatus: asString(mailFrom.MailFromDomainStatus),
    configurationSetName: asString(body.ConfigurationSetName),
  }
}

export type TenantState = {
  tenantArn: string | null
  tenantId: string | null
  /** ENABLED, DISABLED or REINSTATED. */
  sendingStatus: string | null
  /** TENANT for its own list (§4.1.5); ACCOUNT or null for the account's. */
  suppressionScope: string | null
  suppressedReasons: string[]
}

function tenantState(body: Fields): TenantState {
  const suppression = asRecord(body.SuppressionAttributes)
  return {
    tenantArn: asString(body.TenantArn),
    tenantId: asString(body.TenantId),
    sendingStatus: asString(body.SendingStatus),
    suppressionScope: asString(suppression.SuppressionScope),
    suppressedReasons: Array.isArray(suppression.SuppressedReasons)
      ? suppression.SuppressedReasons.filter((r): r is string => typeof r === 'string')
      : [],
  }
}

export type EventDestinationState = {
  name: string | null
  enabled: boolean
  matchingEventTypes: string[]
  topicArn: string | null
}

export type ReputationState = {
  /** The policy's ARN, `…:reputation-policy/strict`. */
  policy: string | null
  customerManagedStatus: string | null
  awsManagedStatus: string | null
  sendingStatus: string | null
}

export type SesQuota = {
  max24HourSend: number | null
  maxSendRate: number | null
  sentLast24Hours: number | null
  sendingEnabled: boolean
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** GetAccount: the shared quota (§4.4). Both Mail keys may read it. */
export async function getSesAccount(
  settings: SesCredentials,
): Promise<SesResult<{ quota: SesQuota }>> {
  assertSesCredentials(settings)
  const answer = await sesCall(settings, { method: 'GET', path: '/account' })
  if (!answer.ok) return answer
  const body = asRecord(answer.json)
  const quota = asRecord(body.SendQuota)
  return {
    ok: true,
    quota: {
      max24HourSend: asNumber(quota.Max24HourSend),
      maxSendRate: asNumber(quota.MaxSendRate),
      sentLast24Hours: asNumber(quota.SentLast24Hours),
      sendingEnabled: body.SendingEnabled === true,
    },
  }
}

const done = (answer: SesAnswer): SesResult => (answer.ok ? { ok: true } : answer)

export function createSesManager(settings: SesCredentials) {
  assertSesCredentials(settings)
  const { region } = settings
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
    sesCall(settings, body === undefined ? { method, path } : { method, path, body })

  return {
    /** §5.1: a domain identity with Easy DKIM at RSA 2048 — three CNAMEs to publish. */
    async createEmailIdentity(
      domain: string,
      options: { configurationSetName?: string } = {},
    ): Promise<SesResult<IdentityState>> {
      check(DOMAIN.test(domain), 'the domain')
      if (options.configurationSetName !== undefined)
        check(NAME.test(options.configurationSetName), 'the configuration set')
      const answer = await call('POST', '/identities', {
        EmailIdentity: domain,
        DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
        ...(options.configurationSetName
          ? { ConfigurationSetName: options.configurationSetName }
          : {}),
      })
      return answer.ok ? { ok: true, ...identityState(answer.json) } : answer
    },

    /** "Check now" and the scheduled re-check (§5). */
    async getEmailIdentity(domain: string): Promise<SesResult<IdentityState>> {
      check(DOMAIN.test(domain), 'the domain')
      const answer = await call('GET', sesPath('identities', domain))
      return answer.ok ? { ok: true, ...identityState(answer.json) } : answer
    },

    async deleteEmailIdentity(domain: string): Promise<SesResult> {
      check(DOMAIN.test(domain), 'the domain')
      return done(await call('DELETE', sesPath('identities', domain)))
    },

    /** §5.2: MAIL FROM on `send.<domain>`; on an MX failure, SES's default domain. */
    async putEmailIdentityMailFromAttributes(
      domain: string,
      mailFromDomain: string,
      behaviorOnMxFailure: 'USE_DEFAULT_VALUE' | 'REJECT_MESSAGE' = 'USE_DEFAULT_VALUE',
    ): Promise<SesResult> {
      check(DOMAIN.test(domain), 'the domain')
      check(
        DOMAIN.test(mailFromDomain) && mailFromDomain.endsWith(`.${domain}`),
        'the MAIL FROM domain',
      )
      return done(
        await call('PUT', `${sesPath('identities', domain)}/mail-from`, {
          MailFromDomain: mailFromDomain,
          BehaviorOnMxFailure: behaviorOnMxFailure,
        }),
      )
    },

    /** §5.3: the account's configuration set as the identity's default. */
    async putEmailIdentityConfigurationSetAttributes(
      domain: string,
      configurationSetName: string,
    ): Promise<SesResult> {
      check(DOMAIN.test(domain), 'the domain')
      check(NAME.test(configurationSetName), 'the configuration set')
      return done(
        await call('PUT', `${sesPath('identities', domain)}/configuration-set`, {
          ConfigurationSetName: configurationSetName,
        }),
      )
    },

    /** §4.1.1 and .5: the account's tenant, with its own suppression list for bounces and complaints. */
    async createTenant(tenantName: string): Promise<SesResult<TenantState>> {
      check(NAME.test(tenantName), 'the tenant name')
      const answer = await call('POST', '/tenants', {
        TenantName: tenantName,
        SuppressionAttributes: {
          SuppressedReasons: ['BOUNCE', 'COMPLAINT'],
          SuppressionScope: 'TENANT',
        },
      })
      return answer.ok ? { ok: true, ...tenantState(asRecord(answer.json)) } : answer
    },

    /** GetTenant: is it there, its ARN (the reputation policy's target) and its suppression. */
    async getTenant(tenantName: string): Promise<SesResult<TenantState>> {
      check(NAME.test(tenantName), 'the tenant name')
      const answer = await call('POST', '/tenants/get', { TenantName: tenantName })
      return answer.ok
        ? { ok: true, ...tenantState(asRecord(asRecord(answer.json).Tenant)) }
        : answer
    },

    /** §4.1.5 for a tenant made without it: its own list, for bounces and complaints. */
    async putTenantSuppressionAttributes(tenantName: string): Promise<SesResult> {
      check(NAME.test(tenantName), 'the tenant name')
      return done(
        await call('POST', '/tenant/suppression', {
          TenantName: tenantName,
          SuppressionScope: 'TENANT',
          SuppressedReasons: ['BOUNCE', 'COMPLAINT'],
        }),
      )
    },

    /**
     * ListTenantResources, every page (at most 20): what the tenant may send
     * with. A type is picked out here, never asked of SES: SES answered
     * BadRequestException to `Filter: { RESOURCE_TYPE: 'CONFIGURATION_SET' }`
     * (eu-west-2, 8 Oct 2026), which held every account's set-up back.
     */
    async listTenantResources(
      tenantName: string,
      resourceType?: TenantResourceType,
    ): Promise<SesResult<{ resources: { resourceArn: string; resourceType: string | null }[] }>> {
      check(NAME.test(tenantName), 'the tenant name')
      const resources: { resourceArn: string; resourceType: string | null }[] = []
      let nextToken: string | null = null
      for (let page = 0; page < 20; page++) {
        const answer = await call('POST', '/tenants/resources/list', {
          TenantName: tenantName,
          PageSize: 100,
          ...(nextToken ? { NextToken: nextToken } : {}),
        })
        if (!answer.ok) return answer
        const body = asRecord(answer.json)
        for (const item of Array.isArray(body.TenantResources) ? body.TenantResources : []) {
          const resourceArn = asString(asRecord(item).ResourceArn)
          const type = asString(asRecord(item).ResourceType)
          if (!resourceArn) continue
          if (resourceType && (type ?? resourceTypeOf(resourceArn))?.toUpperCase() !== resourceType)
            continue
          resources.push({ resourceArn, resourceType: type })
        }
        nextToken = asString(body.NextToken)
        if (!nextToken) break
      }
      return { ok: true, resources }
    },

    /** §5 removal: the identity leaves the tenant (it cannot be deleted while it belongs to one). */
    async deleteTenantResourceAssociation(
      tenantName: string,
      resourceArn: string,
    ): Promise<SesResult> {
      check(NAME.test(tenantName), 'the tenant name')
      check(ARN.test(resourceArn), 'the resource ARN')
      return done(
        await call('POST', '/tenants/resources/delete', {
          TenantName: tenantName,
          ResourceArn: resourceArn,
        }),
      )
    },

    /** GetConfigurationSet: only whether it is there is read. */
    async getConfigurationSet(configurationSetName: string): Promise<SesResult> {
      check(NAME.test(configurationSetName), 'the configuration set')
      return done(await call('GET', sesPath('configuration-sets', configurationSetName)))
    },

    async getConfigurationSetEventDestinations(
      configurationSetName: string,
    ): Promise<SesResult<{ destinations: EventDestinationState[] }>> {
      check(NAME.test(configurationSetName), 'the configuration set')
      const answer = await call(
        'GET',
        `${sesPath('configuration-sets', configurationSetName)}/event-destinations`,
      )
      if (!answer.ok) return answer
      const list = asRecord(answer.json).EventDestinations
      return {
        ok: true,
        destinations: (Array.isArray(list) ? list : []).map((item) => {
          const record = asRecord(item)
          return {
            name: asString(record.Name),
            enabled: record.Enabled === true,
            matchingEventTypes: Array.isArray(record.MatchingEventTypes)
              ? record.MatchingEventTypes.filter((t): t is string => typeof t === 'string')
              : [],
            topicArn: asString(asRecord(record.SnsDestination).TopicArn),
          }
        }),
      }
    },

    /** Puts a destination back to §4.2's seven events on the topic, enabled. */
    async updateConfigurationSetEventDestination(
      configurationSetName: string,
      destinationName: string,
      topicArn: string,
    ): Promise<SesResult> {
      check(NAME.test(configurationSetName), 'the configuration set')
      check(NAME.test(destinationName), 'the destination name')
      check(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/.test(topicArn), 'the topic ARN')
      return done(
        await call(
          'PUT',
          sesPath(
            'configuration-sets',
            configurationSetName,
            'event-destinations',
            destinationName,
          ),
          {
            EventDestination: {
              Enabled: true,
              MatchingEventTypes: [...MAIL_EVENT_TYPES],
              SnsDestination: { TopicArn: topicArn },
            },
          },
        ),
      )
    },

    /** GetReputationEntity: the policy a tenant is on, and who has paused it. */
    async getReputationEntity(resourceArn: string): Promise<SesResult<ReputationState>> {
      check(ARN.test(resourceArn), 'the resource ARN')
      const answer = await call('GET', sesPath('reputation', 'entities', 'RESOURCE', resourceArn))
      if (!answer.ok) return answer
      const entity = asRecord(asRecord(answer.json).ReputationEntity)
      return {
        ok: true,
        policy: asString(entity.ReputationManagementPolicy),
        customerManagedStatus: asString(asRecord(entity.CustomerManagedStatus).Status),
        awsManagedStatus: asString(asRecord(entity.AwsSesManagedStatus).Status),
        sendingStatus: asString(entity.SendingStatusAggregate),
      }
    },

    /** §4.1.3 and §5.4: a configuration set or an identity joins the tenant. */
    async createTenantResourceAssociation(
      tenantName: string,
      resourceArn: string,
    ): Promise<SesResult> {
      check(NAME.test(tenantName), 'the tenant name')
      check(ARN.test(resourceArn), 'the resource ARN')
      return done(
        await call('POST', '/tenants/resources', {
          TenantName: tenantName,
          ResourceArn: resourceArn,
        }),
      )
    },

    /** §4.1.2: the account's configuration set, reputation metrics on, no tracking. */
    async createConfigurationSet(configurationSetName: string): Promise<SesResult> {
      check(NAME.test(configurationSetName), 'the configuration set')
      return done(
        await call('POST', '/configuration-sets', {
          ConfigurationSetName: configurationSetName,
          ReputationOptions: { ReputationMetricsEnabled: true },
          SendingOptions: { SendingEnabled: true },
        }),
      )
    },

    /** §4.1.2: the set's events to the `mail-ses-events` SNS topic. */
    async createConfigurationSetEventDestination(
      configurationSetName: string,
      destinationName: string,
      topicArn: string,
    ): Promise<SesResult> {
      check(NAME.test(configurationSetName), 'the configuration set')
      check(NAME.test(destinationName), 'the destination name')
      check(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/.test(topicArn), 'the topic ARN')
      return done(
        await call(
          'POST',
          `${sesPath('configuration-sets', configurationSetName)}/event-destinations`,
          {
            EventDestinationName: destinationName,
            EventDestination: {
              Enabled: true,
              MatchingEventTypes: [...MAIL_EVENT_TYPES],
              SnsDestination: { TopicArn: topicArn },
            },
          },
        ),
      )
    },

    /** §4.1.4: Strict for an account's first 30 days, then Standard. */
    async updateReputationEntityPolicy(
      resourceArn: string,
      policy: ReputationPolicy,
    ): Promise<SesResult> {
      check(ARN.test(resourceArn), 'the resource ARN')
      return done(
        await call('PUT', `${sesPath('reputation', 'entities', 'RESOURCE', resourceArn)}/policy`, {
          ReputationEntityPolicy: `arn:aws:ses:${region}:aws:reputation-policy/${policy}`,
        }),
      )
    },

    /**
     * §7.4: our own pause (DISABLED). MR5: a pause is final until a person
     * looks — sending again (ENABLED, REINSTATED) needs the admin's reason,
     * and nothing in code calls it on its own.
     */
    async updateReputationEntityCustomerManagedStatus(
      resourceArn: string,
      status: CustomerManagedStatus,
      adminReason?: string,
    ): Promise<SesResult> {
      check(ARN.test(resourceArn), 'the resource ARN')
      if (status !== 'DISABLED' && (adminReason ?? '').trim().length < 10) {
        throw new Error('SES: sending resumes only with an admin’s reason (MR5)')
      }
      return done(
        await call(
          'PUT',
          `${sesPath('reputation', 'entities', 'RESOURCE', resourceArn)}/customer-managed-status`,
          {
            SendingStatus: status,
          },
        ),
      )
    },

    /**
     * §7.5: an address off the tenant's own suppression list (tenant-level
     * suppression: DeleteSuppressedDestination with `TenantName`; without it
     * SES would act on the account-level list, which Mail never uses). SES
     * keeps the address in the case it was sent to and matches it exactly.
     * `NotFoundException` means it is not on the list — the removal is done.
     */
    async deleteSuppressedDestination(
      address: string,
      tenantName: string,
    ): Promise<SesResult<{ found: boolean }>> {
      check(ADDRESS.test(address), 'the address')
      check(NAME.test(tenantName), 'the tenant name')
      const answer = await call(
        'DELETE',
        `${sesPath('suppression', 'addresses', address)}?TenantName=${uriEncode(tenantName)}`,
      )
      if (answer.ok) return { ok: true, found: true }
      if (answer.status === 404 || answer.code === 'NotFoundException') {
        return { ok: true, found: false }
      }
      return answer
    },

    getAccount: () => getSesAccount(settings),
  }
}

export type SesManager = ReturnType<typeof createSesManager>
