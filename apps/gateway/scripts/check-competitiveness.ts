/**
 * Competitiveness check.
 *
 * Our supplier quotes one flat wholesale price across the whole .ng family.
 * The registry does not price them that way and neither does the market, so a
 * price that is fine for .ng can be several times the going rate for .com.ng.
 * This compares what we charge against what competitors charge.
 *
 *   pnpm --filter @dr/gateway check:competitiveness
 *
 * Exit: 0 competitive · 1 failed · 4 priced above the market
 */
import { formatNaira, type PricingInputs, priceFor, type TldCost } from '@dr/shared'
import { createServiceClient } from '../src/lib/db'
import { loadRootEnv } from '../src/lib/env-file'

loadRootEnv()
const db = createServiceClient()

async function main() {
  const [rate, settings, references] = await Promise.all([
    db.from('fx_rates').select('costing_rate, buffer_pct').eq('status', 'active').maybeSingle(),
    db.from('pricing_settings').select('margin_ngn, icann_fee_usd').maybeSingle(),
    db.from('market_references').select('tld, typical_ngn, lowest_ngn, source_note'),
  ])

  if (rate.error || !rate.data) {
    console.error('No active FX rate.')
    process.exit(1)
  }
  if (settings.error || !settings.data) {
    console.error('No pricing settings.')
    process.exit(1)
  }
  if (references.error || !references.data?.length) {
    console.log('No market references recorded — nothing to compare against.')
    process.exit(0)
  }

  const inputs: PricingInputs = {
    fxRate: Number(rate.data.costing_rate),
    fxBufferPct: Number(rate.data.buffer_pct),
    marginNgn: Number(settings.data.margin_ngn),
    icannFeeUsd: Number(settings.data.icann_fee_usd),
  }

  const names = references.data.map((r) => r.tld as string)
  const { data: tlds, error } = await db
    .from('tlds')
    .select('name, register_usd, renew_usd, transfer_usd, restore_usd, is_country_code')
    .in('name', names)

  if (error || !tlds) {
    console.error(`Could not read the catalogue: ${error?.message}`)
    process.exit(1)
  }

  console.log(
    `${'TLD'.padEnd(10)}${'we charge'.padStart(12)}${'typical'.padStart(12)}` +
      `${'lowest'.padStart(12)}${'vs typical'.padStart(13)}`,
  )
  console.log('─'.repeat(59))

  let overpriced = 0

  for (const reference of references.data) {
    const row = tlds.find((t) => t.name === reference.tld)
    if (!row) continue

    const cost: TldCost = {
      name: row.name as string,
      registerUsd: Number(row.register_usd),
      renewUsd: Number(row.renew_usd),
      transferUsd: row.transfer_usd === null ? null : Number(row.transfer_usd),
      restoreUsd: row.restore_usd === null ? null : Number(row.restore_usd),
      isCountryCode: Boolean(row.is_country_code),
    }

    const price = priceFor(cost, 'registration', inputs)
    if (!price) continue

    const ours = price.priceKobo / 100
    const typical = Number(reference.typical_ngn)
    const ratio = ours / typical
    const flag = ratio > 1.15 ? `  OVER by ${((ratio - 1) * 100).toFixed(0)}%` : ''
    if (ratio > 1.15) overpriced++

    console.log(
      `.${(reference.tld as string).padEnd(9)}` +
        `${formatNaira(price.priceKobo).padStart(12)}` +
        `${formatNaira(typical * 100).padStart(12)}` +
        `${formatNaira(Number(reference.lowest_ngn) * 100).padStart(12)}` +
        `${`${ratio.toFixed(2)}x`.padStart(13)}${flag}`,
    )
  }

  if (overpriced > 0) {
    console.log(
      `\n${overpriced} extension(s) priced more than 15% above the going rate.\n` +
        'Our wholesale cost is the constraint, not our margin — the supplier charges\n' +
        'one flat price across this family while the registry and the market do not.\n' +
        'Fixing it means a cheaper source for those extensions, not a smaller margin.',
    )
    process.exit(4)
  }

  console.log('\nAll referenced extensions are within 15% of the going rate.')
  process.exit(0)
}

main().catch((error) => {
  console.error('Check failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
