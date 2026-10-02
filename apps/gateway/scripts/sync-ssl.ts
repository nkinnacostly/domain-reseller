/**
 * SSL product sync (FR-SSL-1) — the supplier's SSL product list into
 * `ssl_products`. The storefront prices certificates from that table only.
 *
 *   pnpm --filter @dr/gateway sync:ssl            # report
 *   pnpm --filter @dr/gateway sync:ssl -- --apply # and write
 *
 * The production gateway runs the same sync weekly and applies it
 * (src/ssl/schedule.ts). It never touches `is_sellable`: which products are
 * sold is the owner's choice (migration 39 marks the three chosen).
 *
 * Read-only against the supplier: it lists products and buys nothing.
 *
 * Exit: 0 no changes · 1 failed or refused · 2 changes detected
 */
import type { Database } from '@dr/db'
import { createClient } from '@supabase/supabase-js'
import { loadRootEnv } from '../src/lib/env-file'
import { getJson } from '../src/lib/http'
import { createSslListingSource, createSslProductStore, syncSslProducts } from '../src/ssl/products'

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
  const result = await syncSslProducts({
    source: createSslListingSource({
      resellerId: RESELLER_ID,
      apiKey: API_KEY,
      environment: process.env.DNA_ENV === 'production' ? 'production' : 'ote',
      getJson,
    }),
    store: createSslProductStore(
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
