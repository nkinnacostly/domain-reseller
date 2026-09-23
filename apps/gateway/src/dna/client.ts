import DomainNameApi from 'nodejs-dna'
import { env } from '../env'
import { createTransport } from './transport'

/**
 * The DomainNameAPI clients for the whole system — constructed here and
 * nowhere else.
 *
 * `telemetry: false` is MANDATORY and asserted by a test.
 * The SDK otherwise reports errors to the vendor's own Sentry, which is an
 * unauthorised third-country transfer of processing metadata under the NDPA
 * (PRD §5.5, SEC-14). Do not remove it.
 *
 * Every client sends through our transport: TLS verified, outcomes recorded.
 */
export type WriteTarget = 'ote' | 'production'

/** Swaps the SDK's HTTP layer for ours. Refuses the SOAP client, which has its own. */
function withVerifiedTransport(client: DomainNameApi): DomainNameApi {
  if (client.getActiveTransport() !== 'REST') {
    throw new Error('DNA_RESELLER_ID must be the reseller UUID: only the REST client is supported')
  }
  client.client._axios = createTransport()
  return client
}

let client: DomainNameApi | null = null

/** Reads: availability and balance, against `DNA_ENV`. */
export function getDnaClient(): DomainNameApi {
  if (client) return client

  client = withVerifiedTransport(
    new DomainNameApi(env.DNA_RESELLER_ID, env.DNA_API_KEY, {
      testMode: env.DNA_ENV !== 'production',
      telemetry: false,
    }),
  )

  return client
}

const writeClients = new Map<WriteTarget, DomainNameApi>()

/**
 * Writes: registrations and nameserver changes. The sandbox has its own key;
 * `env.ts` refuses a production write target outside a production deployment.
 */
export function getDnaWriteClient(target: WriteTarget): DomainNameApi {
  const existing = writeClients.get(target)
  if (existing) return existing

  const key = target === 'ote' ? env.DNA_API_TEST_KEY : env.DNA_API_KEY
  if (!key) throw new Error(`No supplier key for ${target}`)
  const created = withVerifiedTransport(
    new DomainNameApi(env.DNA_RESELLER_ID, key, {
      testMode: target !== 'production',
      telemetry: false,
    }),
  )
  writeClients.set(target, created)
  return created
}

/** Test seam — lets a suite inject a double without touching module internals. */
export function __setDnaClientForTests(stub: DomainNameApi | null): void {
  client = stub
}
