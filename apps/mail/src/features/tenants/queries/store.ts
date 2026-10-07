import 'server-only'

import { z } from 'zod'
import type { MailServiceClient } from '@/lib/supabase/service'

/**
 * The SES jobs' database boundary (migration 47), called with the secret key:
 * what is due is decided in SQL and handed out under a two-minute lease, and
 * every step SES answered is recorded back through the functions — never a
 * table, which the secret key cannot touch in schema `mail`. Answers are
 * parsed here; a shape we did not expect is an error, never a guess.
 */

export class JobsStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string | null,
  ) {
    super(`ses jobs store: ${operation} failed${code ? ` (${code})` : ''}`)
    this.name = 'JobsStoreError'
  }
}

const sandboxSchema = z.object({
  name: z.string(),
  fromAddress: z.string(),
  status: z.enum(['not_created', 'pending', 'verified', 'failed']),
  identityArn: z.string().nullable(),
})

const begun = z.object({
  ok: z.literal(true),
  sandbox: sandboxSchema.extend({ due: z.boolean() }),
})

export type SandboxSender = z.infer<typeof sandboxSchema>
export type JobsBegin = z.infer<typeof begun>

export const provisioningWorkSchema = z.object({
  accountId: z.uuid(),
  shortId: z.string(),
  tenant: z.string(),
  configSet: z.string(),
  state: z.enum(['sandbox', 'active', 'paused', 'closed']),
  createdAt: z.string(),
  tenantReady: z.boolean(),
  tenantArn: z.string().nullable(),
  policy: z.enum(['strict', 'standard']),
  steps: z.object({
    tenant: z.boolean(),
    suppression: z.boolean(),
    configSet: z.boolean(),
    eventDestination: z.boolean(),
    configSetAssociated: z.boolean(),
    strictPolicy: z.boolean(),
    standardPolicy: z.boolean(),
    sandboxAssociated: z.boolean(),
  }),
  work: z.array(z.enum(['provision', 'policy', 'sandbox_join', 'sandbox_leave'])),
  sandbox: sandboxSchema,
  attempts: z.number().int(),
})

export type ProvisioningWork = z.infer<typeof provisioningWorkSchema>

export const domainWorkSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  name: z.string(),
  status: z.enum(['pending', 'verified', 'failed', 'removing']),
  work: z.enum(['setup', 'check', 'expire', 'teardown']),
  mailFromDomain: z.string().nullable(),
  identityArn: z.string().nullable(),
  dkimTokens: z.array(z.string()),
  steps: z.object({
    identity: z.boolean(),
    mailFrom: z.boolean(),
    configSet: z.boolean(),
    tenant: z.boolean(),
  }),
  tenant: z.string(),
  configSet: z.string(),
  tenantReady: z.boolean(),
  claimedAt: z.string(),
  deadline: z.string(),
  lastCheckedAt: z.string().nullable(),
  attempts: z.number().int(),
})

export type DomainWork = z.infer<typeof domainWorkSchema>

/** What a record function answered: done, or refused with a code (lease_lost, validation…). */
export type Recorded = { ok: true; [key: string]: unknown } | { ok: false; code: string }

const recorded = z.union([
  z.looseObject({ ok: z.literal(true) }),
  z.looseObject({ ok: z.literal(false), code: z.string() }),
])

export type DomainCheckState = {
  found: boolean
  verifiedForSending?: boolean
  verificationStatus?: string | null
  dkimStatus?: string | null
  dkimTokens?: string[]
  mailFromStatus?: string | null
}

export type SandboxState = {
  status: 'not_created' | 'pending' | 'verified' | 'failed'
  identityArn: string | null
  dkimTokens: string[]
  mailFromStatus: string | null
}

export type DomainFailure =
  | 'dkim_record_missing'
  | 'dkim_not_verified'
  | 'not_set_up'
  | 'ses_refused'
  | 'ses_identity_exists'

export function createJobsStore(db: MailServiceClient) {
  async function call(operation: string, run: PromiseLike<{ data: unknown; error: unknown }>) {
    const { data, error } = await run
    if (error) {
      throw new JobsStoreError(operation, (error as { code?: string }).code ?? null)
    }
    return data
  }

  async function recordedBy(
    operation: string,
    run: PromiseLike<{ data: unknown; error: unknown }>,
  ): Promise<Recorded> {
    const parsed = recorded.safeParse(await call(operation, run))
    if (!parsed.success) throw new JobsStoreError(operation, 'unexpected_answer')
    return parsed.data as Recorded
  }

  return {
    /** The route's bearer token, checked in SQL; a heartbeat when it is right. */
    async begin(token: string): Promise<JobsBegin | null> {
      const data = await call('begin_ses_jobs', db.rpc('begin_ses_jobs', { p_token: token }))
      const parsed = begun.safeParse(data)
      return parsed.success ? parsed.data : null
    },

    async claimProvisioning(
      worker: string,
      limit: number,
      e2e: boolean,
      accountId?: string,
    ): Promise<ProvisioningWork[]> {
      const data = await call(
        'claim_provisioning_work',
        db.rpc('claim_provisioning_work', {
          p_worker: worker,
          p_limit: limit,
          p_e2e: e2e,
          ...(accountId ? { p_account_id: accountId } : {}),
        }),
      )
      const parsed = z.array(provisioningWorkSchema).safeParse(data)
      if (!parsed.success) throw new JobsStoreError('claim_provisioning_work', 'unexpected_answer')
      return parsed.data
    },

    recordProvisioning(
      accountId: string,
      worker: string,
      step: string,
      detail: Record<string, unknown> = {},
    ): Promise<Recorded> {
      return recordedBy(
        'record_provisioning',
        db.rpc('record_provisioning', {
          p_account_id: accountId,
          p_worker: worker,
          p_step: step,
          p_detail: detail as never,
        }),
      )
    },

    recordProvisioningError(
      accountId: string,
      worker: string,
      error: string,
      retryAfter: number,
    ): Promise<Recorded> {
      return recordedBy(
        'record_provisioning_error',
        db.rpc('record_provisioning_error', {
          p_account_id: accountId,
          p_worker: worker,
          p_error: error,
          p_retry_after: retryAfter,
        }),
      )
    },

    async claimDomains(
      worker: string,
      limit: number,
      e2e: boolean,
      only: { domainId?: string; accountId?: string } = {},
    ): Promise<DomainWork[]> {
      const data = await call(
        'claim_domain_work',
        db.rpc('claim_domain_work', {
          p_worker: worker,
          p_limit: limit,
          p_e2e: e2e,
          ...(only.domainId ? { p_domain_id: only.domainId } : {}),
          ...(only.accountId ? { p_account_id: only.accountId } : {}),
        }),
      )
      const parsed = z.array(domainWorkSchema).safeParse(data)
      if (!parsed.success) throw new JobsStoreError('claim_domain_work', 'unexpected_answer')
      return parsed.data
    },

    recordDomainStep(
      domainId: string,
      worker: string,
      step: 'identity' | 'mail_from' | 'config_set' | 'tenant',
      detail: Record<string, unknown> = {},
    ): Promise<Recorded> {
      return recordedBy(
        'record_domain_step',
        db.rpc('record_domain_step', {
          p_domain_id: domainId,
          p_worker: worker,
          p_step: step,
          p_detail: detail as never,
        }),
      )
    },

    recordDomainCheck(
      domainId: string,
      worker: string,
      state: DomainCheckState,
    ): Promise<Recorded> {
      return recordedBy(
        'record_domain_check',
        db.rpc('record_domain_check', {
          p_domain_id: domainId,
          p_worker: worker,
          p_state: state as never,
        }),
      )
    },

    recordDomainFailed(
      domainId: string,
      worker: string,
      reason: DomainFailure,
      missingRecord: string | null,
    ): Promise<Recorded> {
      return recordedBy(
        'record_domain_failed',
        db.rpc('record_domain_failed', {
          p_domain_id: domainId,
          p_worker: worker,
          p_reason: reason,
          ...(missingRecord ? { p_missing_record: missingRecord } : {}),
        }),
      )
    },

    recordDomainReleased(domainId: string, worker: string): Promise<Recorded> {
      return recordedBy(
        'record_domain_released',
        db.rpc('record_domain_released', { p_domain_id: domainId, p_worker: worker }),
      )
    },

    recordDomainError(
      domainId: string,
      worker: string,
      error: string,
      retryAfter: number,
    ): Promise<Recorded> {
      return recordedBy(
        'record_domain_error',
        db.rpc('record_domain_error', {
          p_domain_id: domainId,
          p_worker: worker,
          p_error: error,
          p_retry_after: retryAfter,
        }),
      )
    },

    recordSandboxIdentity(state: SandboxState): Promise<Recorded> {
      return recordedBy(
        'record_sandbox_identity',
        db.rpc('record_sandbox_identity', { p_state: state as never }),
      )
    },
  }
}

export type JobsStore = ReturnType<typeof createJobsStore>
