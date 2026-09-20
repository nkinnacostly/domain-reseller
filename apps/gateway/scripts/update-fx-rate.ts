/**
 * Daily FX rate update (PRD FR-FX-1..FR-FX-5).
 *
 *   pnpm --filter @dr/gateway fx:update              # fetch, evaluate, report
 *   pnpm --filter @dr/gateway fx:update -- --apply   # and write to the database
 *   pnpm --filter @dr/gateway fx:update -- --manual 1395 --apply
 *
 * A rate that moves more than the threshold in one update is STORED but not
 * activated. Someone looks at it. A bad feed or a decimal slip must not
 * silently reprice the whole catalogue.
 *
 * Exit: 0 applied or unchanged · 1 failed · 3 held for review
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  costingRate,
  DEFAULT_MOVE_THRESHOLD_PCT,
  evaluateRateChange,
  type RateQuote,
} from '@dr/shared'
import { createClient } from '@supabase/supabase-js'
import { AbokiParallelProvider } from '../src/lib/fx-provider'

const envPath = fileURLToPath(new URL('../../../.env', import.meta.url))
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
  const [key, ...rest] = trimmed.split('=')
  if (key && !process.env[key]) process.env[key] = rest.join('=').replace(/^["']|["']$/g, '')
}

const APPLY = process.argv.includes('--apply')
const manualIndex = process.argv.indexOf('--manual')
const MANUAL_RATE = manualIndex !== -1 ? Number(process.argv[manualIndex + 1]) : null
const BUFFER_PCT = Number(process.env.FX_BUFFER_PCT ?? 4)

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const secretKey = process.env.SUPABASE_SECRET_KEY
if (!supabaseUrl || !secretKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  process.exit(1)
}

// Writes bypass RLS by design: there is no client-side path to a rate.
const db = createClient(supabaseUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function getQuote(): Promise<RateQuote> {
  if (MANUAL_RATE !== null) {
    if (!Number.isFinite(MANUAL_RATE) || MANUAL_RATE <= 0) {
      throw new Error(`--manual needs a positive rate, got "${process.argv[manualIndex + 1]}"`)
    }
    // A manual entry is a single figure: what a dollar costs us today.
    return { source: 'manual', buy: MANUAL_RATE, sell: MANUAL_RATE, quotedAt: new Date() }
  }

  const apiKey = process.env.FX_SOURCE_API_KEY
  if (!apiKey) {
    throw new Error(
      'FX_SOURCE_API_KEY is not set. Either subscribe to the parallel-market feed, ' +
        'or set a rate by hand with: fx:update -- --manual <rate> --apply',
    )
  }

  return new AbokiParallelProvider(apiKey).fetchQuote()
}

async function main() {
  const { data: current, error: readError } = await db
    .from('fx_rates')
    .select('id, costing_rate, source, effective_from')
    .eq('status', 'active')
    .maybeSingle()

  /**
   * A failed read is NOT "no rate exists".
   *
   * Swallowing this error made the job report `Current: none` when the
   * database held an active rate it simply could not see — which routes every
   * update down the no-baseline path and skips the move guard entirely.
   * A rate job that cannot read the current rate must stop.
   */
  if (readError) {
    console.error(`Could not read the current rate: ${readError.message}`)
    console.error('Refusing to continue — the move guard needs a baseline to compare against.')
    process.exit(1)
  }

  const currentRate = current ? Number(current.costing_rate) : null

  const quote = await getQuote()
  const incoming = costingRate(quote)

  console.log(`Source     : ${quote.source}`)
  console.log(`Quoted at  : ${quote.quotedAt.toISOString()}`)
  console.log(`Buy / sell : ₦${quote.buy} / ₦${quote.sell}`)
  console.log(`Costing at : ₦${incoming}  (we buy dollars, so we pay the sell rate)`)
  console.log(
    `Current    : ${currentRate === null ? 'none' : `₦${currentRate} from ${current?.source}`}`,
  )

  const decision = evaluateRateChange(currentRate, incoming, DEFAULT_MOVE_THRESHOLD_PCT)

  if (decision.action === 'reject') {
    console.error(`\nREJECTED: ${decision.reason}`)
    process.exit(1)
  }

  const effective = incoming * (1 + BUFFER_PCT / 100)
  console.log(`Effective  : ₦${effective.toFixed(2)} after the ${BUFFER_PCT}% buffer`)

  if (decision.action === 'accept' && Math.abs(decision.movePct) < 0.0001 && currentRate !== null) {
    console.log('\nNo change. Nothing written.')
    process.exit(0)
  }

  if (!APPLY) {
    console.log(
      `\n${decision.action === 'accept' ? 'Would apply' : 'Would hold for review'}. ` +
        'Re-run with --apply to write it.',
    )
    process.exit(decision.action === 'accept' ? 0 : 3)
  }

  const { data: inserted, error } = await db
    .from('fx_rates')
    .insert({
      source: quote.source,
      buy_rate: quote.buy,
      sell_rate: quote.sell,
      costing_rate: incoming,
      buffer_pct: BUFFER_PCT,
      status: 'pending_review',
      move_pct: decision.action === 'accept' ? decision.movePct : decision.movePct,
      review_reason: decision.action === 'hold_for_review' ? decision.reason : null,
      quoted_at: quote.quotedAt.toISOString(),
    })
    .select('id')
    .single()

  if (error || !inserted) {
    console.error('\nInsert failed:', error?.message)
    process.exit(1)
  }

  if (decision.action === 'hold_for_review') {
    console.log(`\nHELD FOR REVIEW: ${decision.reason}`)
    console.log(`Stored as ${inserted.id}. Prices are unchanged until it is activated.`)
    process.exit(3)
  }

  const { error: activateError } = await db.rpc('activate_fx_rate', { rate_id: inserted.id })
  if (activateError) {
    console.error('\nActivation failed:', activateError.message)
    process.exit(1)
  }

  console.log(`\nApplied. Prices now convert at ₦${effective.toFixed(2)} to the dollar.`)
  process.exit(0)
}

main().catch((error) => {
  console.error('FX update failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
