import {
  isSesAlreadyThere,
  isSesNotFound,
  MAIL_EVENT_DESTINATION,
  MAIL_EVENT_TYPES,
  type SesFailure,
  sesResourceArn,
} from '@dr/shared/ses'
import type { JobsStore, ProvisioningWork } from '../queries/store'
import { retryAfterSeconds, type SesSetup } from './ses'

/**
 * An account's SES tenant (MAIL-SPEC §4.1), claimed in SQL under a lease
 * (`claim_provisioning_work`, migration 47). Each step not yet recorded is
 * read from SES first and written only if missing, so a half-done
 * provisioning resumes and never duplicates:
 *
 *   1. CreateTenant `mdm-<short id>`, with tenant-level suppression (§4.1.5)
 *   2. CreateConfigurationSet `mdm-<short id>`
 *   3. its event destination to the mail-ses-events topic, the seven events
 *   4. the set joined to the tenant
 *   5. the reputation policy: Strict for 30 days, then Standard
 *
 * SQL sets `tenant_ready_at` when all five are recorded. The same claim also
 * joins the shared sandbox sender to a sandbox account's tenant, and takes it
 * off an account that has left the sandbox (§7.2).
 */

export type ProvisionDeps = { ses: SesSetup; store: JobsStore; worker: string }

export type ProvisionOutcome = 'ready' | 'done' | 'error' | 'lost'

class Stop extends Error {
  constructor(readonly outcome: ProvisionOutcome) {
    super(outcome)
  }
}

const policyIs = (arn: string | null, policy: 'strict' | 'standard') =>
  arn?.endsWith(`reputation-policy/${policy}`) ?? false

export async function runProvisioning(
  item: ProvisioningWork,
  deps: ProvisionDeps,
): Promise<ProvisionOutcome> {
  const { store, worker } = deps

  async function failed(failure: SesFailure): Promise<never> {
    await store.recordProvisioningError(
      item.accountId,
      worker,
      failure.error,
      retryAfterSeconds(failure, item.attempts),
    )
    throw new Stop('error')
  }

  async function step(name: string, detail: Record<string, unknown> = {}): Promise<boolean> {
    const answer = await store.recordProvisioning(item.accountId, worker, name, detail)
    if (!answer.ok) throw new Stop('lost')
    return answer.ready === true
  }

  try {
    let ready = item.tenantReady
    let tenantArn = item.tenantArn
    if (item.work.includes('provision') || !tenantArn) {
      tenantArn = await ensureTenant(item, deps, failed, step)
      ready = (await ensureRest(item, deps, tenantArn, failed, step)) || ready
    }
    if (item.work.includes('policy') && tenantArn) {
      ready = (await ensurePolicy(deps, tenantArn, 'standard', failed, step)) || ready
    }
    if (item.work.includes('sandbox_join') && item.sandbox.identityArn) {
      await ensureSandbox(item, deps, item.sandbox.identityArn, true, failed)
      await step('sandbox_join')
    }
    if (item.work.includes('sandbox_leave') && item.sandbox.identityArn) {
      await ensureSandbox(item, deps, item.sandbox.identityArn, false, failed)
      await step('sandbox_leave')
    }
    await step('done')
    return ready && !item.tenantReady ? 'ready' : 'done'
  } catch (error) {
    if (error instanceof Stop) return error.outcome
    throw error
  }
}

type Failed = (failure: SesFailure) => Promise<never>
type Step = (name: string, detail?: Record<string, unknown>) => Promise<boolean>

/** §4.1.1 and .5: the tenant, with its own suppression list. Answers its ARN. */
async function ensureTenant(
  item: ProvisioningWork,
  { ses }: ProvisionDeps,
  failed: Failed,
  step: Step,
): Promise<string> {
  let tenant = await ses.manager.getTenant(item.tenant)
  if (!tenant.ok && isSesNotFound(tenant)) {
    const made = await ses.manager.createTenant(item.tenant)
    tenant = made.ok || !isSesAlreadyThere(made) ? made : await ses.manager.getTenant(item.tenant)
  }
  if (!tenant.ok) return failed(tenant)
  if (!tenant.tenantArn) {
    return failed({
      ok: false,
      status: null,
      code: null,
      retryable: true,
      error: 'no tenant ARN yet',
    })
  }
  await step('tenant', {
    tenantArn: tenant.tenantArn,
    ...(tenant.sendingStatus ? { sendingStatus: tenant.sendingStatus } : {}),
  })
  if (!item.steps.suppression) {
    const own =
      tenant.suppressionScope === 'TENANT' &&
      tenant.suppressedReasons.includes('BOUNCE') &&
      tenant.suppressedReasons.includes('COMPLAINT')
    if (!own) {
      const put = await ses.manager.putTenantSuppressionAttributes(item.tenant)
      if (!put.ok) return failed(put)
    }
    await step('suppression')
  }
  return tenant.tenantArn
}

/** §4.1.2–4: the set, its destination, the association, and the policy. Answers whether ready. */
async function ensureRest(
  item: ProvisioningWork,
  deps: ProvisionDeps,
  tenantArn: string,
  failed: Failed,
  step: Step,
): Promise<boolean> {
  const { manager, region, awsAccount, topicArn } = deps.ses
  let ready = false

  if (!item.steps.configSet) {
    const set = await manager.getConfigurationSet(item.configSet)
    if (!set.ok) {
      if (!isSesNotFound(set)) return failed(set)
      const made = await manager.createConfigurationSet(item.configSet)
      if (!made.ok && !isSesAlreadyThere(made)) return failed(made)
    }
    ready = (await step('config_set')) || ready
  }

  if (!item.steps.eventDestination) {
    const listed = await manager.getConfigurationSetEventDestinations(item.configSet)
    if (!listed.ok) return failed(listed)
    const ours = listed.destinations.find((d) => d.name === MAIL_EVENT_DESTINATION)
    const right =
      ours?.enabled === true &&
      ours.topicArn === topicArn &&
      MAIL_EVENT_TYPES.every((type) => ours.matchingEventTypes.includes(type)) &&
      ours.matchingEventTypes.length === MAIL_EVENT_TYPES.length
    if (!ours) {
      const made = await manager.createConfigurationSetEventDestination(
        item.configSet,
        MAIL_EVENT_DESTINATION,
        topicArn,
      )
      if (!made.ok && !isSesAlreadyThere(made)) return failed(made)
    } else if (!right) {
      const put = await manager.updateConfigurationSetEventDestination(
        item.configSet,
        MAIL_EVENT_DESTINATION,
        topicArn,
      )
      if (!put.ok) return failed(put)
    }
    ready = (await step('event_destination')) || ready
  }

  if (!item.steps.configSetAssociated) {
    const setArn = sesResourceArn(region, awsAccount, 'configuration-set', item.configSet)
    const held = await manager.listTenantResources(item.tenant, 'CONFIGURATION_SET')
    if (!held.ok) return failed(held)
    if (!held.resources.some((resource) => resource.resourceArn === setArn)) {
      const joined = await manager.createTenantResourceAssociation(item.tenant, setArn)
      if (!joined.ok && !isSesAlreadyThere(joined)) return failed(joined)
    }
    ready = (await step('config_set_association')) || ready
  }

  if (!item.steps.strictPolicy && !item.steps.standardPolicy) {
    ready = (await ensurePolicy(deps, tenantArn, item.policy, failed, step)) || ready
  }
  return ready
}

/** §4.1.4: Strict for an account's first 30 days, then Standard. */
async function ensurePolicy(
  { ses }: ProvisionDeps,
  tenantArn: string,
  policy: 'strict' | 'standard',
  failed: Failed,
  step: Step,
): Promise<boolean> {
  const entity = await ses.manager.getReputationEntity(tenantArn)
  if (!entity.ok) return failed(entity)
  if (!policyIs(entity.policy, policy)) {
    const put = await ses.manager.updateReputationEntityPolicy(tenantArn, policy)
    if (!put.ok) return failed(put)
  }
  return step('policy', { policy })
}

/** §7.2: the shared sandbox sender joins (or leaves) the account's tenant. */
async function ensureSandbox(
  item: ProvisioningWork,
  { ses }: ProvisionDeps,
  identityArn: string,
  join: boolean,
  failed: Failed,
): Promise<void> {
  const held = await ses.manager.listTenantResources(item.tenant, 'EMAIL_IDENTITY')
  if (!held.ok) return failed(held)
  const there = held.resources.some((resource) => resource.resourceArn === identityArn)
  if (join && !there) {
    const joined = await ses.manager.createTenantResourceAssociation(item.tenant, identityArn)
    if (!joined.ok && !isSesAlreadyThere(joined)) return failed(joined)
  }
  if (!join && there) {
    const left = await ses.manager.deleteTenantResourceAssociation(item.tenant, identityArn)
    if (!left.ok && !isSesNotFound(left)) return failed(left)
  }
}
