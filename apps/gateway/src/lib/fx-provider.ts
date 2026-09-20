import type { FxSource, RateQuote } from '@dr/shared'
import { getJson } from './http'

export interface FxProvider {
  readonly source: FxSource
  fetchQuote(): Promise<RateQuote>
}

/** ExchangeRate-API's open endpoint. No key, updates daily. */
export class ErApiProvider implements FxProvider {
  readonly source: FxSource = 'er-api'

  async fetchQuote(): Promise<RateQuote> {
    const data = (await getJson('https://open.er-api.com/v6/latest/USD')) as {
      result?: string
      rates?: Record<string, number>
      time_last_update_unix?: number
    }

    if (data.result && data.result !== 'success') {
      throw new Error(`er-api returned result=${data.result}`)
    }
    const rate = data.rates?.NGN
    if (typeof rate !== 'number') throw new Error('er-api response has no NGN rate')

    return {
      source: this.source,
      rate,
      quotedAt: data.time_last_update_unix
        ? new Date(data.time_last_update_unix * 1000)
        : new Date(),
    }
  }
}

/** An independent open dataset, used to cross-check the first. */
export class CurrencyApiProvider implements FxProvider {
  readonly source: FxSource = 'currency-api'

  async fetchQuote(): Promise<RateQuote> {
    const data = (await getJson(
      'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
    )) as { date?: string; usd?: Record<string, number> }

    const rate = data.usd?.ngn
    if (typeof rate !== 'number') throw new Error('currency-api response has no NGN rate')

    return {
      source: this.source,
      rate,
      quotedAt: data.date ? new Date(data.date) : new Date(),
    }
  }
}

/**
 * Aboki Forex parallel-market rates. Paid, and optional.
 *
 * [VERIFY] Shape follows their published docs; not yet exercised with a key.
 * When FX_PARALLEL_API_KEY is set this joins the cross-check.
 */
export class AbokiParallelProvider implements FxProvider {
  readonly source: FxSource = 'aboki-parallel'

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://abokiforespaid.uc.r.appspot.com/_ah/api/forex/v1',
  ) {}

  async fetchQuote(): Promise<RateQuote> {
    const data = (await getJson(`${this.baseUrl}/rates/USD`, { 'X-API-Key': this.apiKey })) as {
      timestamp?: string
      rates?: Record<string, { buy?: number; sell?: number }>
    }

    const usd = data.rates?.USD
    // We BUY dollars, so we pay what the dealer sells at — never the midpoint.
    if (typeof usd?.sell !== 'number') throw new Error('aboki response has no USD sell rate')

    return {
      source: this.source,
      rate: usd.sell,
      quotedAt: data.timestamp ? new Date(data.timestamp) : new Date(),
    }
  }
}

/** Every provider we can use right now, given the configured keys. */
export function availableProviders(): FxProvider[] {
  const providers: FxProvider[] = [new ErApiProvider(), new CurrencyApiProvider()]

  const parallelKey = process.env.FX_PARALLEL_API_KEY
  if (parallelKey) providers.push(new AbokiParallelProvider(parallelKey))

  return providers
}
