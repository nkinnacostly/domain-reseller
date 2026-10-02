import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createPriceRefresh } from '../catalogue/refresh'
import { createCatalogueSchedule } from '../catalogue/schedule'
import { createRunLog } from '../catalogue/store'
import type { Env } from '../env'
import { getJson } from '../lib/http'
import { supplierSlots } from '../lib/semaphore'
import {
  createSslListingSource,
  createSslProductStore,
  summariseSsl,
  syncSslProducts,
} from './products'

/**
 * The weekly SSL product sync (FR-SSL-1, N5b), beside the domain catalogue's
 * and on the same rules: only the production deployment reading production
 * runs it, it reports before it writes, refuses what it cannot trust, and
 * leaves each run's outcome in the `ssl_catalogue:production` heartbeat —
 * which migration 39's alert reads.
 */

export const SSL_CATALOGUE_HEARTBEAT = 'ssl_catalogue:production'

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export function sslCatalogueScheduleFor(
  env: Env,
  log: Log,
  deps: {
    client?: SupabaseClient<Database>
    getJson?: typeof getJson
    fetchImpl?: typeof fetch
  } = {},
) {
  if (env.NODE_ENV !== 'production' || env.DNA_ENV !== 'production') return null

  const client =
    deps.client ??
    createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  const source = createSslListingSource({
    resellerId: env.DNA_RESELLER_ID,
    apiKey: env.DNA_API_KEY,
    environment: 'production',
    // Behind people's searches, in the two supplier slots.
    run: (task) => supplierSlots.run(task, { waitMs: 5 * 60_000, priority: 'low' }),
    getJson: deps.getJson ?? getJson,
  })
  const store = createSslProductStore(client)
  return createCatalogueSchedule({
    sync: () => syncSslProducts({ source, store, apply: true }),
    summarise: summariseSsl,
    label: 'SSL product sync',
    runs: createRunLog(client, SSL_CATALOGUE_HEARTBEAT),
    everyMs: env.CATALOGUE_SYNC_EVERY_HOURS * 3_600_000,
    refreshPrices: env.APP_URL ? createPriceRefresh(env.APP_URL, deps.fetchImpl) : null,
    log,
  })
}
