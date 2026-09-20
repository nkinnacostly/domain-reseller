/**
 * Live FX update.
 *
 *   pnpm --filter @dr/gateway fx:update            # fetch and report
 *   pnpm --filter @dr/gateway fx:update -- --apply # and activate
 *
 * Fetches every configured source, cross-checks them, and refuses to apply a
 * rate the sources disagree on or that moved further than the threshold.
 *
 * Exit: 0 applied or unchanged · 1 failed · 3 held for review
 */
import { crossCheckQuotes, evaluateRateChange, type RateQuote } from '@dr/shared'
import { createServiceClient } from '../src/lib/db'
import { loadRootEnv } from '../src/lib/env-file'
import { availableProviders } from '../src/lib/fx-provider'

loadRootEnv()
const APPLY = process.argv.includes('--apply')
const db = createServiceClient()

async function main() {
  const { data: settings, error: settingsError } = await db
    .from('pricing_settings')
    .select('fx_buffer_pct, fx_move_threshold_pct')
    .single()

  if (settingsError || !settings) {
    console.error(`Could not read pricing settings: ${settingsError?.message ?? 'no row'}`)
    process.exit(1)
  }

  const { data: current, error: readError } = await db
    .from('fx_rates')
    .select('costing_rate, source')
    .eq('status', 'active')
    .maybeSingle()

  // A failed read is not "no rate". Continuing would skip the move guard.
  if (readError) {
    console.error(`Could not read the current rate: ${readError.message}`)
    process.exit(1)
  }

  const providers = availableProviders()
  console.log(`Sources: ${providers.map((p) => p.source).join(', ')}\n`)

  const quotes: RateQuote[] = []
  for (const provider of providers) {
    try {
      const quote = await provider.fetchQuote()
      quotes.push(quote)
      console.log(`  ${provider.source.padEnd(16)} ₦${quote.rate.toFixed(4)}`)
    } catch (error) {
      // One source failing is survivable; all of them failing is not.
      console.warn(`  ${provider.source.padEnd(16)} FAILED — ${(error as Error).message}`)
    }
  }

  const check = crossCheckQuotes(quotes)
  if (!check.agreed) {
    console.error(`\nNot applying: ${check.reason}`)
    process.exit(1)
  }

  console.log(`\nReconciled : ₦${check.rate.toFixed(4)} (spread ${check.spreadPct.toFixed(2)}%)`)

  const currentRate = current ? Number(current.costing_rate) : null
  console.log(`Current    : ${currentRate === null ? 'none' : `₦${currentRate}`}`)

  const decision = evaluateRateChange(
    currentRate,
    check.rate,
    Number(settings.fx_move_threshold_pct),
  )

  if (decision.action === 'reject') {
    console.error(`\nREJECTED: ${decision.reason}`)
    process.exit(1)
  }

  const buffer = Number(settings.fx_buffer_pct)
  console.log(
    `Effective  : ₦${(check.rate * (1 + buffer / 100)).toFixed(2)} after a ${buffer}% buffer`,
  )

  if (decision.action === 'accept' && Math.abs(decision.movePct) < 0.0001 && currentRate !== null) {
    console.log('\nNo change.')
    process.exit(0)
  }

  if (!APPLY) {
    console.log(
      `\n${decision.action === 'accept' ? 'Would apply' : `Would hold — ${decision.reason}`}.` +
        ' Re-run with --apply.',
    )
    process.exit(decision.action === 'accept' ? 0 : 3)
  }

  // The reconciled rate is the median, so attribute it to the median source.
  const primary = quotes.find((q) => q.rate === check.rate) ?? quotes[0]

  const { data: inserted, error: insertError } = await db
    .from('fx_rates')
    .insert({
      source: primary?.source ?? 'er-api',
      buy_rate: check.rate,
      sell_rate: check.rate,
      costing_rate: check.rate,
      buffer_pct: buffer,
      status: 'pending_review',
      move_pct: decision.movePct,
      review_reason: decision.action === 'hold_for_review' ? decision.reason : null,
      quoted_at: (primary?.quotedAt ?? new Date()).toISOString(),
      raw_payload: {
        quotes: quotes.map((q) => ({ source: q.source, rate: q.rate })),
        spreadPct: check.spreadPct,
      },
    })
    .select('id')
    .single()

  if (insertError || !inserted) {
    console.error('\nInsert failed:', insertError?.message)
    process.exit(1)
  }

  if (decision.action === 'hold_for_review') {
    console.log(`\nHELD: ${decision.reason}`)
    console.log(`Stored as ${inserted.id}. Prices unchanged until it is activated.`)
    process.exit(3)
  }

  const { error: activateError } = await db.rpc('activate_fx_rate', { rate_id: inserted.id })
  if (activateError) {
    console.error('\nActivation failed:', activateError.message)
    process.exit(1)
  }

  console.log('\nApplied.')
  process.exit(0)
}

main().catch((error) => {
  console.error('FX update failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
