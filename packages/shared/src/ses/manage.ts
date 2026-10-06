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

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
const NAME = /^[A-Za-z0-9_-]{1,64}$/
const ARN = /^arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:\S+$/
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
    async createTenant(
      tenantName: string,
    ): Promise<
      SesResult<{ tenantArn: string | null; tenantId: string | null; sendingStatus: string | null }>
    > {
      check(NAME.test(tenantName), 'the tenant name')
      const answer = await call('POST', '/tenants', {
        TenantName: tenantName,
        SuppressionAttributes: {
          SuppressedReasons: ['BOUNCE', 'COMPLAINT'],
          SuppressionScope: 'TENANT',
        },
      })
      if (!answer.ok) return answer
      const body = asRecord(answer.json)
      return {
        ok: true,
        tenantArn: asString(body.TenantArn),
        tenantId: asString(body.TenantId),
        sendingStatus: asString(body.SendingStatus),
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
