/**
 * Catalogue sync — pulls wholesale costs from the reseller platform into the
 * `tlds` table. The storefront prices from that table, so this is the only
 * source of cost data.
 *
 *   pnpm --filter @dr/gateway sync:catalogue            # report
 *   pnpm --filter @dr/gateway sync:catalogue -- --apply # and write
 *
 * The production gateway runs the same sync weekly and applies it
 * (src/catalogue/schedule.ts): once the supplier allowlists the gateway's
 * address, a run from anywhere else is refused by the supplier.
 *
 * Read-only against the supplier: it fetches the product catalogue and nothing
 * else. It never registers, renews or transfers.
 *
 * Exit: 0 no changes · 1 failed or refused · 2 changes detected
 */
import type { Database } from '@dr/db'
import { createClient } from '@supabase/supabase-js'
import { createCatalogueStore } from '../src/catalogue/store'
import { createCatalogueSource } from '../src/catalogue/supplier'
import { syncCatalogue } from '../src/catalogue/sync'
import { loadRootEnv } from '../src/lib/env-file'

loadRootEnv()

const APPLY = process.argv.includes('--apply')
const RESELLER_ID = process.env.DNA_RESELLER_ID ?? ''
const API_KEY = process.env.DNA_API_KEY ?? ''
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY ?? ''

if (!RESELLER_ID || !API_KEY) {
  console.error('DNA_RESELLER_ID and DNA_API_KEY must be set')
  process.exit(1)
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  process.exit(1)
}

async function main() {
  const result = await syncCatalogue({
    source: createCatalogueSource({
      resellerId: RESELLER_ID,
      apiKey: API_KEY,
      environment: process.env.DNA_ENV === 'production' ? 'production' : 'ote',
    }),
    store: createCatalogueStore(
      createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      }),
    ),
    apply: APPLY,
  })

  for (const line of result.report) console.log(line)
  if (result.outcome === 'refused') process.exit(1)
  process.exit(result.outcome === 'unchanged' ? 0 : 2)
}

main().catch((error) => {
  console.error('Sync failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
