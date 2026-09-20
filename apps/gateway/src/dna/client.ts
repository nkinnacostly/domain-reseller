import DomainNameApi from 'nodejs-dna'
import { env } from '../env'

/**
 * The single DomainNameAPI client for the whole system.
 *
 * `telemetry: false` is MANDATORY and asserted by a test.
 * The SDK otherwise reports errors to the vendor's own Sentry, which is an
 * unauthorised third-country transfer of processing metadata under the NDPA
 * (PRD §5.5, SEC-14). Do not remove it, and do not construct the SDK elsewhere.
 */
let client: DomainNameApi | null = null

export function getDnaClient(): DomainNameApi {
  if (client) return client

  client = new DomainNameApi(env.DNA_RESELLER_ID, env.DNA_API_KEY, {
    testMode: env.DNA_ENV !== 'production',
    telemetry: false,
  })

  return client
}

/** Test seam — lets a suite inject a double without touching module internals. */
export function __setDnaClientForTests(stub: DomainNameApi | null): void {
  client = stub
}
