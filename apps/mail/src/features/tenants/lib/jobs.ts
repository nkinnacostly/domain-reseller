import type { DnsLookup } from '@/features/domains/lib/dns-check'
import { type DomainOutcome, runDomainWork } from '@/features/domains/lib/run'
import type { JobsBegin, JobsStore } from '../queries/store'
import { type ProvisionOutcome, runProvisioning } from './provision'
import { readSandboxIdentity } from './sandbox'
import type { SesSetup } from './ses'

/**
 * One run of the SES job route (MAIL-SPEC §4.1, §5, §7.2): pg_cron asks every
 * five minutes, and pg_net at once when an account is made (migration 47).
 * The shared sandbox sender is read while it is due; then accounts to
 * provision, then domains with work due, each claimed in SQL under a lease.
 * The run stops claiming once its time is spent; what is left waits for the
 * next one. Nothing here is lost by stopping: every step is recorded as it
 * happens.
 */

export type JobsDeps = {
  ses: SesSetup
  store: JobsStore
  lookup: DnsLookup
  worker: string
  now?: () => number
}

export type JobsSummary = {
  sandbox: string | null
  accounts: Partial<Record<ProvisionOutcome, number>>
  domains: Partial<Record<DomainOutcome, number>>
}

export const ACCOUNTS_PER_CLAIM = 10
export const DOMAINS_PER_CLAIM = 25

const count = <T extends string>(tally: Partial<Record<T, number>>, key: T) => {
  tally[key] = (tally[key] ?? 0) + 1
}

export async function runSesJobs(
  deps: JobsDeps,
  begun: JobsBegin,
  { accountId, budgetMs = 25_000 }: { accountId?: string; budgetMs?: number } = {},
): Promise<JobsSummary> {
  const now = deps.now ?? Date.now
  const stopAt = now() + budgetMs
  const e2e = deps.ses.side === 'mock'
  const summary: JobsSummary = { sandbox: null, accounts: {}, domains: {} }

  // Only the real side speaks for the shared sender: a mock never does.
  if (!e2e && begun.sandbox.due) {
    const read = await readSandboxIdentity(deps.ses.manager, {
      name: begun.sandbox.name,
      region: deps.ses.region,
      awsAccount: deps.ses.awsAccount,
    })
    if (read.ok) {
      const recorded = await deps.store.recordSandboxIdentity(read.state)
      summary.sandbox = recorded.ok ? read.state.status : 'refused'
    } else {
      summary.sandbox = 'unanswered'
    }
  }

  const accountDeps = { ses: deps.ses, store: deps.store, worker: deps.worker }
  if (accountId) {
    for (const item of await deps.store.claimProvisioning(deps.worker, 1, e2e, accountId)) {
      count(summary.accounts, await runProvisioning(item, accountDeps))
    }
  }
  while (now() < stopAt) {
    const claimed = await deps.store.claimProvisioning(deps.worker, ACCOUNTS_PER_CLAIM, e2e)
    for (const item of claimed) count(summary.accounts, await runProvisioning(item, accountDeps))
    if (claimed.length < ACCOUNTS_PER_CLAIM) break
  }

  const domainDeps = { ...accountDeps, lookup: deps.lookup }
  while (now() < stopAt) {
    const claimed = await deps.store.claimDomains(deps.worker, DOMAINS_PER_CLAIM, e2e)
    for (const item of claimed) count(summary.domains, await runDomainWork(item, domainDeps))
    if (claimed.length < DOMAINS_PER_CLAIM) break
  }
  return summary
}
