import { describe, expect, it, vi } from 'vitest'
import { createCatalogueSource } from './supplier'

/** The listing is read page by page; a page that is not a listing stops the read. */

const item = (name: string) => ({ name })

function pages(...answers: unknown[]) {
  const queue = [...answers]
  return vi.fn(async (_url: string, _headers?: Record<string, string>, _timeoutMs?: number) => {
    if (queue.length === 0) throw new Error('asked for a page nobody expected')
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  })
}

const source = (getJson: ReturnType<typeof pages>, over: Record<string, unknown> = {}) =>
  createCatalogueSource({
    resellerId: 'reseller',
    apiKey: 'k',
    environment: 'production',
    pageSize: 2,
    getJson,
    ...over,
  })

describe('reading the catalogue', () => {
  it('reads every page, with our credentials, from the live platform', async () => {
    const get = pages(
      { totalCount: 3, items: [item('com'), item('net')] },
      { totalCount: 3, items: [item('org')] },
    )
    await expect(source(get)()).resolves.toEqual({
      items: [item('com'), item('net'), item('org')],
      total: 3,
    })
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      'https://api.domainresellerapi.com/api/v1/products/tlds?MaxResultCount=2&SkipCount=0',
      'https://api.domainresellerapi.com/api/v1/products/tlds?MaxResultCount=2&SkipCount=2',
    ])
    expect(get.mock.calls[0]?.[1]).toEqual({ 'X-API-KEY': 'k', __reseller: 'reseller' })
    expect(get.mock.calls[0]?.[2]).toBe(60_000)
  })

  it('reads the sandbox listing for the sandbox', async () => {
    const get = pages({ totalCount: 0, items: [] })
    await source(get, { environment: 'ote' })()
    expect(get.mock.calls[0]?.[0]).toMatch(/^https:\/\/ote\.domainresellerapi\.com\/api\/v1\//)
  })

  it('stops once it has as many as the platform said, even on a full page', async () => {
    const get = pages({ totalCount: 2, items: [item('com'), item('net')] })
    await expect(source(get)()).resolves.toMatchObject({ total: 2 })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('reports no total when the platform gives none, for the sync to refuse', async () => {
    const get = pages({ items: [item('com')] })
    await expect(source(get)()).resolves.toEqual({ items: [item('com')], total: null })
  })

  it('stops at a page that is not a listing', async () => {
    await expect(source(pages({ error: 'nope' }))()).rejects.toThrow('not a listing')
    await expect(source(pages(null))()).rejects.toThrow('not a listing')
  })

  it('passes a failed request on', async () => {
    await expect(source(pages(new Error('HTTP 401: ')))()).rejects.toThrow('HTTP 401')
  })

  it('stops paging a listing that never ends', async () => {
    const endless = vi.fn(async () => ({ items: [item('a'), item('b')] }))
    await expect(source(endless as never)()).rejects.toThrow('ran past 40 pages')
    expect(endless).toHaveBeenCalledTimes(40)
  })

  it('makes each request inside the slot it is given', async () => {
    const order: string[] = []
    const run = async <T>(task: () => Promise<T>) => {
      order.push('slot')
      return task()
    }
    const get = pages({ totalCount: 1, items: [item('com')] })
    get.mockImplementationOnce(async () => {
      order.push('request')
      return { totalCount: 1, items: [item('com')] }
    })
    await source(get, { run })()
    expect(order).toEqual(['slot', 'request'])
  })
})
