import {
  type IdentityState,
  isSesAlreadyThere,
  isSesNotFound,
  type SesFailure,
  type SesResult,
  sesResourceArn,
} from '@dr/shared/ses'
import type { SesSetup } from '@/features/tenants/lib/ses'
import { retryAfterSeconds } from '@/features/tenants/lib/ses'
import type { DomainCheckState, DomainWork, JobsStore } from '@/features/tenants/queries/store'
import type { DnsLookup } from './dns-check'
import { domainRecords } from './records'

/**
 * One domain's SES work (MAIL-SPEC §5), claimed in SQL under a lease
 * (`claim_domain_work`, migration 47), each step read from SES before it is
 * written and recorded as SES answered:
 *
 *   setup    — the identity with Easy DKIM (RSA 2048), MAIL FROM on send.,
 *              the account's configuration set as its default, the identity
 *              joined to the account's tenant; then a first check
 *   check    — GetEmailIdentity: verified once SES says so and set-up is done
 *   expire   — 72 hours unproven: a last read, then failed naming the DKIM
 *              record public DNS does not have, and released
 *   teardown — off the tenant, deleted from SES (a removal, or a failed claim)
 *              — only an identity this claim recorded making
 *
 * Never adopt an identity someone else made (migration 54, review 12): one
 * SES holds already, that this claim never recorded creating
 * (identity_created_at), fails the claim as `ses_identity_exists` and is left
 * exactly as it is — not joined to the tenant, not deleted on release.
 *
 * SES refusing or not answering is recorded with its status and type only,
 * and tried again later (`record_domain_error`); a lease another runner now
 * holds ends the run quietly.
 */

export type DomainRunDeps = {
  ses: SesSetup
  store: JobsStore
  worker: string
  lookup: DnsLookup
}

export type DomainOutcome =
  | 'verified'
  | 'pending'
  | 'waiting'
  | 'failed'
  | 'released'
  | 'error'
  | 'lost'

/** After this many refusals in a row, a set-up SES will not accept fails (§5). */
export const SETUP_REFUSALS_BEFORE_FAILING = 4

class Stop extends Error {
  constructor(readonly outcome: DomainOutcome) {
    super(outcome)
  }
}

export async function runDomainWork(item: DomainWork, deps: DomainRunDeps): Promise<DomainOutcome> {
  try {
    switch (item.work) {
      case 'setup':
        return await setUp(item, deps)
      case 'check':
        return await check(item, deps)
      case 'expire':
        return await expire(item, deps)
      case 'teardown':
        return await tearDown(item, deps)
    }
  } catch (error) {
    if (error instanceof Stop) return error.outcome
    throw error
  }
}

const identityArn = (item: DomainWork, ses: SesSetup) =>
  sesResourceArn(ses.region, ses.awsAccount, 'identity', item.name)

/** A step SES refused or did not answer: recorded and retried later, or failed after enough refusals. */
async function failed(item: DomainWork, deps: DomainRunDeps, failure: SesFailure): Promise<never> {
  if (
    item.work === 'setup' &&
    !failure.retryable &&
    item.attempts + 1 >= SETUP_REFUSALS_BEFORE_FAILING
  ) {
    const answer = await deps.store.recordDomainFailed(item.id, deps.worker, 'ses_refused', null)
    if (!answer.ok) throw new Stop('lost')
    await tearDown(item, deps)
    throw new Stop('failed')
  }
  await deps.store.recordDomainError(
    item.id,
    deps.worker,
    failure.error,
    retryAfterSeconds(failure, item.attempts),
  )
  throw new Stop('error')
}

/** A record call that did not take (the lease went to another runner) ends this run. */
function kept(answer: { ok: boolean }): void {
  if (!answer.ok) throw new Stop('lost')
}

async function readIdentity(
  item: DomainWork,
  deps: DomainRunDeps,
): Promise<SesResult<IdentityState> | null> {
  const answer = await deps.ses.manager.getEmailIdentity(item.name)
  if (answer.ok) return answer
  if (isSesNotFound(answer)) return null
  return failed(item, deps, answer)
}

function checkState(identity: SesResult<IdentityState> | null): DomainCheckState {
  if (!identity?.ok) return { found: false }
  return {
    found: true,
    verifiedForSending: identity.verifiedForSending,
    verificationStatus: identity.verificationStatus,
    dkimStatus: identity.dkimStatus,
    dkimTokens: identity.dkimTokens,
    mailFromStatus: identity.mailFromStatus,
  }
}

async function recordCheck(
  item: DomainWork,
  deps: DomainRunDeps,
  identity: SesResult<IdentityState> | null,
): Promise<DomainOutcome> {
  const answer = await deps.store.recordDomainCheck(item.id, deps.worker, checkState(identity))
  if (!answer.ok) throw new Stop('lost')
  return answer.status === 'verified' ? 'verified' : 'pending'
}

async function setUp(item: DomainWork, deps: DomainRunDeps): Promise<DomainOutcome> {
  const { manager } = deps.ses
  const arn = identityArn(item, deps.ses)

  // §5.1: the identity, or the one SES already holds for this claim — never
  // one this claim did not make.
  let identity = await readIdentity(item, deps)
  if (identity && !item.steps.identity) return notOurs(item, deps)
  if (!identity) {
    const made = await manager.createEmailIdentity(item.name)
    if (made.ok) identity = made
    else if (isSesAlreadyThere(made)) {
      if (!item.steps.identity) return notOurs(item, deps)
      identity = await readIdentity(item, deps)
    } else return failed(item, deps, made)
  }
  if (!identity?.ok || identity.dkimTokens.length === 0) {
    return failed(item, deps, {
      ok: false,
      status: null,
      code: null,
      retryable: true,
      error: 'no DKIM tokens yet',
    })
  }
  if (!item.steps.identity || identity.dkimTokens.join() !== item.dkimTokens.join()) {
    kept(
      await deps.store.recordDomainStep(item.id, deps.worker, 'identity', {
        identityArn: arn,
        dkimTokens: identity.dkimTokens,
        dkimStatus: identity.dkimStatus,
      }),
    )
  }

  // §5.2: MAIL FROM on send.<domain>.
  const mailFrom = `send.${item.name}`
  if (identity.mailFromDomain !== mailFrom) {
    const put = await manager.putEmailIdentityMailFromAttributes(item.name, mailFrom)
    if (!put.ok) return failed(item, deps, put)
  }
  if (!item.steps.mailFrom || identity.mailFromDomain !== mailFrom) {
    kept(
      await deps.store.recordDomainStep(item.id, deps.worker, 'mail_from', {
        mailFromDomain: mailFrom,
      }),
    )
  }

  // §5.3–5.4 need the account's set and tenant (§4.1).
  if (!item.tenantReady) {
    kept(await deps.store.recordDomainError(item.id, deps.worker, 'tenant not ready', 60))
    return 'waiting'
  }

  if (identity.configurationSetName !== item.configSet) {
    const put = await manager.putEmailIdentityConfigurationSetAttributes(item.name, item.configSet)
    if (!put.ok) return failed(item, deps, put)
  }
  if (!item.steps.configSet || identity.configurationSetName !== item.configSet) {
    kept(await deps.store.recordDomainStep(item.id, deps.worker, 'config_set'))
  }

  if (!item.steps.tenant) {
    const held = await manager.listTenantResources(item.tenant, 'EMAIL_IDENTITY')
    if (!held.ok) return failed(item, deps, held)
    if (!held.resources.some((resource) => resource.resourceArn === arn)) {
      const joined = await manager.createTenantResourceAssociation(item.tenant, arn)
      if (!joined.ok && !isSesAlreadyThere(joined)) return failed(item, deps, joined)
    }
    kept(await deps.store.recordDomainStep(item.id, deps.worker, 'tenant'))
  }

  return recordCheck(item, deps, await readIdentity(item, deps))
}

/**
 * SES holds an identity for this name that this claim never recorded making:
 * someone else's. The claim fails and the name is released without touching
 * that identity (teardown deletes only what the claim made).
 */
async function notOurs(item: DomainWork, deps: DomainRunDeps): Promise<DomainOutcome> {
  kept(await deps.store.recordDomainFailed(item.id, deps.worker, 'ses_identity_exists', null))
  await tearDown({ ...item, steps: { ...item.steps, identity: false } }, deps)
  return 'failed'
}

async function check(item: DomainWork, deps: DomainRunDeps): Promise<DomainOutcome> {
  return recordCheck(item, deps, await readIdentity(item, deps))
}

async function expire(item: DomainWork, deps: DomainRunDeps): Promise<DomainOutcome> {
  const identity = await readIdentity(item, deps)
  const setUpDone =
    item.steps.identity && item.steps.mailFrom && item.steps.configSet && item.steps.tenant
  if (identity?.ok && identity.verifiedForSending && setUpDone) {
    return recordCheck(item, deps, identity)
  }

  // §5: failed, naming the record that is missing.
  let reason: 'dkim_record_missing' | 'dkim_not_verified' | 'not_set_up' = 'not_set_up'
  let missing: string | null = null
  const tokens =
    identity?.ok && identity.dkimTokens.length > 0 ? identity.dkimTokens : item.dkimTokens
  if (setUpDone && tokens.length > 0) {
    const dkim = domainRecords({
      name: item.name,
      dkimTokens: tokens,
      mailFromDomain: item.mailFromDomain,
      region: deps.ses.region,
    }).filter((record) => record.purpose === 'dkim')
    const seen = await deps.lookup(dkim)
    const absent = dkim.find((record) => {
      const state = seen.find((view) => view.id === record.id)?.state
      return state === 'missing' || state === 'different'
    })
    reason = absent ? 'dkim_record_missing' : 'dkim_not_verified'
    missing = absent?.name ?? null
  }
  kept(await deps.store.recordDomainFailed(item.id, deps.worker, reason, missing))
  await tearDown(item, deps)
  return 'failed'
}

async function tearDown(item: DomainWork, deps: DomainRunDeps): Promise<DomainOutcome> {
  const { manager } = deps.ses
  const arn = identityArn(item, deps.ses)
  // Only an identity this claim made is ours to take off the tenant and delete.
  if (item.steps.identity) {
    // An identity in a tenant cannot be deleted: off the tenant first.
    const left = await manager.deleteTenantResourceAssociation(item.tenant, arn)
    if (!left.ok && !isSesNotFound(left)) return failed({ ...item, work: 'teardown' }, deps, left)
    const gone = await manager.deleteEmailIdentity(item.name)
    if (!gone.ok && !isSesNotFound(gone)) return failed({ ...item, work: 'teardown' }, deps, gone)
  }
  kept(await deps.store.recordDomainReleased(item.id, deps.worker))
  return 'released'
}
