import 'server-only'

import { randomUUID } from 'node:crypto'
import { runProvisioning } from '@/features/tenants/lib/provision'
import { SesNotConfigured, sesSetup } from '@/features/tenants/lib/ses'
import { createJobsStore } from '@/features/tenants/queries/store'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { type DomainOutcome, runDomainWork } from '../lib/run'
import { dnsLookup } from './dns'

/**
 * The SES work a person (or an API key) just asked for, done now rather than
 * at the next five-minute run: an add sets the domain up at once (and the
 * account's tenant first, when it is new), "Check now" reads SES, a removal
 * lets the identity go. The same claim-and-record functions as the job
 * route, so a run already holding the domain is left to finish (`busy`).
 * Anything that cannot be done now is left for the job route (`later`): the
 * person's change is already recorded in SQL either way.
 */

export type Settled = DomainOutcome | 'busy' | 'later'

export async function settleDomainNow({
  accountId,
  domainId,
  provision = false,
}: {
  accountId: string
  domainId: string
  provision?: boolean
}): Promise<Settled> {
  try {
    const ses = sesSetup()
    const store = createJobsStore(createServiceClient())
    const worker = `web:${randomUUID().slice(0, 8)}`
    const e2e = ses.side === 'mock'
    if (provision) {
      for (const item of await store.claimProvisioning(worker, 1, e2e, accountId)) {
        await runProvisioning(item, { ses, store, worker })
      }
    }
    const [item] = await store.claimDomains(worker, 1, e2e, { domainId, accountId })
    if (!item) return 'busy'
    return await runDomainWork(item, { ses, store, worker, lookup: dnsLookup() })
  } catch (error) {
    if (error instanceof SesNotConfigured) {
      logger.warn(
        { domainId, missing: error.missing },
        'domain left for the job route: SES not configured',
      )
    } else {
      logger.error(
        { domainId, err: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
        'domain left for the job route',
      )
    }
    return 'later'
  }
}
