import { request as httpsRequest } from 'node:https'
import type { FxSource, RateQuote } from '@dr/shared'

/**
 * Sources for the naira/dollar rate.
 *
 * We track the PARALLEL market, not the official window, because that is where
 * dollars to fund the supplier balance are actually bought. The official rate
 * would understate our cost.
 */
export interface FxProvider {
  readonly source: FxSource
  fetchQuote(): Promise<RateQuote>
}

type AbokiResponse = {
  timestamp?: string
  baseCurrency?: string
  rateType?: string
  rates?: Record<string, { buy?: number; sell?: number }>
}

/**
 * Aboki Forex parallel-market API.
 *
 * https://abokiforex.app/api — paid, ₦70,000/month, 100 requests a day, rates
 * refresh hourly. We need one call a day, so the quota is ample.
 *
 * [VERIFY] The response shape below follows their published documentation but
 * has not been exercised against a live key. Run the job once in report mode
 * after subscribing and confirm before trusting it to move prices.
 */
export class AbokiParallelProvider implements FxProvider {
  readonly source: FxSource = 'aboki-parallel'

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://abokiforespaid.uc.r.appspot.com/_ah/api/forex/v1',
  ) {}

  async fetchQuote(): Promise<RateQuote> {
    const payload = (await this.get('/rates/USD')) as AbokiResponse

    const usd = payload.rates?.USD
    if (!usd || typeof usd.buy !== 'number' || typeof usd.sell !== 'number') {
      throw new Error(
        `Unexpected response shape from ${this.source}: ${JSON.stringify(payload).slice(0, 200)}`,
      )
    }

    // Guard against them switching to NGN-as-base or an official feed without
    // telling us — either would silently reprice the whole catalogue.
    if (payload.baseCurrency && payload.baseCurrency !== 'NGN') {
      throw new Error(`Expected NGN-denominated rates, got ${payload.baseCurrency}`)
    }
    if (payload.rateType && payload.rateType !== 'black_market') {
      throw new Error(`Expected parallel-market rates, got ${payload.rateType}`)
    }

    return {
      source: this.source,
      buy: usd.buy,
      sell: usd.sell,
      quotedAt: payload.timestamp ? new Date(payload.timestamp) : new Date(),
    }
  }

  /** node:https — Node's fetch trips a TLS error against some of these hosts. */
  private get(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        `${this.baseUrl}${path}`,
        {
          method: 'GET',
          headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' },
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            if (res.statusCode === 429) {
              reject(new Error('Rate limit reached (100/day). Quota resets at 00:00 UTC.'))
              return
            }
            if (!res.statusCode || res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
              return
            }
            try {
              resolve(JSON.parse(body))
            } catch {
              reject(new Error(`Non-JSON response: ${body.slice(0, 200)}`))
            }
          })
        },
      )
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.end()
    })
  }
}
