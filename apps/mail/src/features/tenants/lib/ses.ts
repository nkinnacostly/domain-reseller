import 'server-only'

import {
  awsAccountOf,
  createSesManager,
  type Fetch,
  type SesFailure,
  type SesManager,
  sesBaseUrl,
} from '@dr/shared/ses'
import { env, requireSesManagerEnv, testEndpoints } from '@/lib/env'

/**
 * SES as this app may use it (MAIL-SPEC §4.3): the manager key — identities,
 * tenants, configuration sets, reputation; never a send — in the SES region,
 * with the AWS account read from the events topic's ARN (SES gives no ARN for
 * an identity or a set, and a tenant association needs one).
 *
 * `side` says which accounts a job may touch: `real` SES never works on a
 * test account, and the e2e mock (MAIL_SES_ENDPOINT, loopback only, refused
 * in production) only on test accounts — migration 47's claims hold both.
 */

export type SesSide = 'real' | 'mock'

export type SesSetup = {
  manager: SesManager
  region: string
  awsAccount: string
  topicArn: string
  side: SesSide
}

export class SesNotConfigured extends Error {
  constructor(readonly missing: string) {
    super(`SES management is not configured: ${missing}`)
    this.name = 'SesNotConfigured'
  }
}

/** Every SES request goes to `endpoint` instead (the e2e mock), path and signature unchanged. */
export function redirectFetch(region: string, endpoint: string): Fetch {
  const origin = new URL(sesBaseUrl(region)).origin
  const target = endpoint.replace(/\/+$/, '')
  return (url, init) =>
    fetch(
      url.startsWith(origin) ? `${target}${url.slice(origin.length)}` : url,
      init as RequestInit,
    )
}

export function sesSetup(): SesSetup {
  const { ses: endpoint } = testEndpoints()
  let credentials: ReturnType<typeof requireSesManagerEnv>
  try {
    credentials = requireSesManagerEnv()
  } catch {
    throw new SesNotConfigured(
      'MAIL_SES_MANAGER_ACCESS_KEY_ID and MAIL_SES_MANAGER_SECRET_ACCESS_KEY',
    )
  }
  const topicArn = env.MAIL_SES_EVENTS_TOPIC_ARN
  const awsAccount = topicArn ? awsAccountOf(topicArn) : null
  if (!topicArn || !awsAccount) throw new SesNotConfigured('MAIL_SES_EVENTS_TOPIC_ARN')
  return {
    manager: createSesManager({
      ...credentials,
      ...(endpoint ? { fetch: redirectFetch(credentials.region, endpoint) } : {}),
    }),
    region: credentials.region,
    awsAccount,
    topicArn,
    side: endpoint ? 'mock' : 'real',
  }
}

/**
 * When to try again after SES refused or did not answer: soon for what may
 * pass (throttled, SES unwell, no answer), slowly for a refusal — doubling
 * with each attempt, at most an hour or six.
 */
export function retryAfterSeconds(failure: SesFailure, attempts: number): number {
  const step = Math.min(Math.max(attempts, 0), 10)
  return failure.retryable ? Math.min(60 * 2 ** step, 3_600) : Math.min(900 * 2 ** step, 21_600)
}
