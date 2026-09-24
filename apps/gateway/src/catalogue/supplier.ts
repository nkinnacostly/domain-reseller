import { getJson } from '../lib/http'
import type { Listing, RawTld } from './catalogue'

/**
 * Reads the whole product catalogue from the reseller platform. Read-only:
 * it never registers, renews or transfers anything.
 *
 * The REST listing is read directly rather than through the SDK's
 * GetTldList, which fetches one page only and fills missing label limits
 * with defaults that look like data.
 */

const BASE_URL = {
  production: 'https://api.domainresellerapi.com/api/v1',
  ote: 'https://ote.domainresellerapi.com/api/v1',
} as const

/** Far beyond the ~720 extensions listed; stops a supplier bug from paging forever. */
const MAX_PAGES = 40

export type CatalogueSourceOptions = {
  resellerId: string
  apiKey: string
  environment: 'ote' | 'production'
  pageSize?: number
  timeoutMs?: number
  /** Wraps each request; the gateway passes its supplier slots (two in flight per account). */
  run?: <T>(task: () => Promise<T>) => Promise<T>
  getJson?: typeof getJson
}

export type CatalogueSource = () => Promise<Listing>

export function createCatalogueSource(options: CatalogueSourceOptions): CatalogueSource {
  const {
    resellerId,
    apiKey,
    environment,
    pageSize = 250,
    timeoutMs = 60_000,
    run = (task) => task(),
    getJson: get = getJson,
  } = options

  return async function readListing(): Promise<Listing> {
    const items: RawTld[] = []
    let total: number | null = null

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = `${BASE_URL[environment]}/products/tlds?MaxResultCount=${pageSize}&SkipCount=${page * pageSize}`
      const answer = await run(() =>
        get(url, { 'X-API-KEY': apiKey, __reseller: resellerId }, timeoutMs),
      )
      if (
        typeof answer !== 'object' ||
        answer === null ||
        !Array.isArray((answer as { items?: unknown }).items)
      ) {
        throw new Error('The catalogue page was not a listing')
      }
      const { items: pageItems, totalCount } = answer as { items: RawTld[]; totalCount?: unknown }
      if (typeof totalCount === 'number' && Number.isInteger(totalCount)) total = totalCount
      items.push(...pageItems)
      if (pageItems.length < pageSize || (total !== null && items.length >= total)) {
        return { items, total }
      }
    }
    throw new Error(`The catalogue ran past ${MAX_PAGES} pages; stopped reading`)
  }
}
