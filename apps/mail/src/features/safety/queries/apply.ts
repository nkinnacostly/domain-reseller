import 'server-only'

import { createSesManager, type SesCredentials, sesCall } from '@dr/shared/ses'
import { env, requireSesManagerEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import {
  type ApplyRun,
  applyTenantActions,
  type TenantActionStore,
  type TenantStatusSetter,
} from '../lib/tenant-actions'

/**
 * apps/mail's half of a pause (MAIL-SPEC §7.4, §4.3): the queued tenant
 * changes, applied with the manager key. Called by the safety route when the
 * worker pings it, and straight after an admin's pause or resume. The secret
 * key reaches only claim_tenant_actions and record_tenant_action in schema
 * `mail` (migration 51).
 */

/** Names this caller in each claim. */
const WORKER = 'mail-app:safety'

const ARN = /^arn:aws:ses:[a-z0-9-]+:\d{12}:tenant\/\S+$/

/** GetTenant and the customer-managed status, on the manager key. */
export function sesTenantStatus(settings: SesCredentials): TenantStatusSetter {
  const manager = createSesManager(settings)
  return {
    async tenantArn(tenantName) {
      const answer = await sesCall(settings, {
        method: 'POST',
        path: '/tenants/get',
        body: { TenantName: tenantName },
      })
      if (!answer.ok) return { ok: false, status: answer.status, code: answer.code }
      const tenant = (answer.json as { Tenant?: { TenantArn?: unknown } } | null)?.Tenant
      const arn = typeof tenant?.TenantArn === 'string' ? tenant.TenantArn : ''
      return ARN.test(arn)
        ? { ok: true, arn }
        : { ok: false, status: answer.status, code: 'NoTenantArn' }
    },
    async setStatus(arn, status, reason) {
      const answer = await manager.updateReputationEntityCustomerManagedStatus(arn, status, reason)
      return answer.ok ? { ok: true } : { ok: false, status: answer.status, code: answer.code }
    },
  }
}

/** The service role's two calls, answers checked. */
export function tenantActionStore(): TenantActionStore {
  const db = createServiceClient()
  return {
    async claim(worker, limit) {
      const { data, error } = await db.rpc('claim_tenant_actions', {
        p_worker: worker,
        p_limit: limit,
      })
      if (error) throw new Error(`claim_tenant_actions failed (${error.code ?? 'unknown'})`)
      return Array.isArray(data) ? data : []
    },
    async record(id, worker, outcome, error) {
      const { data, error: failed } = await db.rpc('record_tenant_action', {
        p_action_id: id,
        p_worker: worker,
        p_outcome: outcome,
        ...(error ? { p_error: error } : {}),
      })
      if (failed) throw new Error(`record_tenant_action failed (${failed.code ?? 'unknown'})`)
      if ((data as { ok?: unknown } | null)?.ok !== true) {
        logger.warn({ action: id }, 'a tenant action was no longer ours to record')
      }
    },
  }
}

export type ApplyAnswer = ApplyRun | { skipped: 'ses_not_configured' }

/**
 * Applies what is due. Without the manager key (e2e, a laptop) nothing is
 * claimed: the actions wait, our own gate holds, and the alert says so.
 */
export async function applyDueTenantActions(): Promise<ApplyAnswer> {
  if (!env.MAIL_SES_MANAGER_ACCESS_KEY_ID || !env.MAIL_SES_MANAGER_SECRET_ACCESS_KEY) {
    return { skipped: 'ses_not_configured' }
  }
  const run = await applyTenantActions({
    store: tenantActionStore(),
    ses: sesTenantStatus(requireSesManagerEnv()),
    worker: WORKER,
    log: logger,
  })
  if (run.claimed > 0) logger.info({ ...run }, 'tenant status changes applied')
  return run
}
