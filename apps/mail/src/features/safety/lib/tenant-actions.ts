import { z } from 'zod'

/**
 * SES's side of a pause or resume (MAIL-SPEC §7.4, §4.3, MR5). SQL pauses an
 * account in our own gate at once and queues the tenant's customer-managed
 * status in `mail.tenant_actions`; this applies them with the manager key,
 * which only apps/mail holds — the worker's sender key cannot.
 *
 * For each claimed action: read the tenant's ARN by its name (GetTenant),
 * then UpdateReputationEntityCustomerManagedStatus. Whatever SES answers
 * short of success goes back to the queue with SES's status and error type
 * only, and SQL retries it with backoff; after 15 minutes it is a critical
 * alert. ENABLED exists only after an owner's audited resume (MR5): nothing
 * here decides to resume anything.
 */

export const claimedActionSchema = z.object({
  id: z.number().int().positive(),
  accountId: z.uuid(),
  accountShortId: z.string(),
  tenant: z.string().regex(/^mdm-[0-9a-f]{10}$/),
  sendingStatus: z.enum(['DISABLED', 'ENABLED']),
  why: z.enum(['threshold', 'admin_pause', 'admin_resume']),
  requestedBy: z.string(),
  attempt: z.number().int().positive(),
})

export type ClaimedTenantAction = z.infer<typeof claimedActionSchema>

export type SesAnswer = { ok: true } | { ok: false; status: number | null; code: string | null }

export type TenantActionStore = {
  claim(worker: string, limit: number): Promise<unknown[]>
  record(id: number, worker: string, outcome: 'applied' | 'retry', error?: string): Promise<void>
}

export type TenantStatusSetter = {
  tenantArn(
    tenantName: string,
  ): Promise<{ ok: true; arn: string } | Exclude<SesAnswer, { ok: true }>>
  setStatus(arn: string, status: 'DISABLED' | 'ENABLED', reason: string): Promise<SesAnswer>
}

export type ApplyRun = { claimed: number; applied: number; retried: number; unreadable: number }

/** SES's status and error type, in the words tenant_actions.last_error keeps. */
export function describeSesFailure(answer: { status: number | null; code: string | null }): string {
  const status = answer.status === null ? 'no answer' : `HTTP ${answer.status}`
  return answer.code ? `${status} ${answer.code}` : status
}

/** The reason SES's manager call carries for a resume (MR5: an admin's, with their label). */
export function resumeReason(action: ClaimedTenantAction): string {
  return `Resumed in Mail's admin by ${action.requestedBy} (tenant action ${action.id})`
}

export async function applyTenantActions(options: {
  store: TenantActionStore
  ses: TenantStatusSetter
  worker: string
  limit?: number
  log?: { warn(fields: object, message: string): void }
}): Promise<ApplyRun> {
  const { store, ses, worker, limit = 10, log } = options
  const rows = await store.claim(worker, limit)
  const run: ApplyRun = { claimed: rows.length, applied: 0, retried: 0, unreadable: 0 }

  for (const row of rows) {
    const parsed = claimedActionSchema.safeParse(row)
    if (!parsed.success) {
      // Its claim lapses in five minutes and it is alerted on: never guessed at.
      run.unreadable += 1
      log?.warn({ issues: parsed.error.issues.length }, 'a tenant action could not be read')
      continue
    }
    const action = parsed.data
    const found = await ses.tenantArn(action.tenant)
    const answer = found.ok
      ? await ses.setStatus(
          found.arn,
          action.sendingStatus,
          action.sendingStatus === 'ENABLED' ? resumeReason(action) : 'paused',
        )
      : found
    if (answer.ok) {
      await store.record(action.id, worker, 'applied')
      run.applied += 1
    } else {
      const error = describeSesFailure(answer)
      await store.record(action.id, worker, 'retry', error)
      run.retried += 1
      log?.warn(
        { action: action.id, account: action.accountShortId, status: action.sendingStatus, error },
        'SES did not take a tenant status change; it is retried',
      )
    }
  }
  return run
}
