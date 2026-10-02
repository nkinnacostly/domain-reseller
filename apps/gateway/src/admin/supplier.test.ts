import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_GET,
  ALLOWED_POST_READ,
  buildQuery,
  createAdminSupplier,
  NotAllowed,
  PARAMS,
  SUPPLIER_BASE_URL,
} from './supplier'

/** ADMIN-SPEC §4.2, D11: reads only, on a fixed list, with fixed parameter names. */

function supplier() {
  const send = vi.fn(async (_url: string, _init?: unknown) => ({ status: 200, body: {} }))
  const lanes: unknown[] = []
  const run = <T>(task: () => Promise<T>, lane: unknown): Promise<T> => {
    lanes.push(lane)
    return task()
  }
  const instance = createAdminSupplier({
    environment: 'ote',
    apiKey: 'sandbox-key',
    resellerId: 'reseller-1',
    run,
    send: send as never,
  })
  return { instance, send, lanes }
}

const LOW = { priority: 'low', waitMs: 15_000 } as const

describe('the admin supplier allowlist', () => {
  it('is exactly the paths and parameters the spec lists', () => {
    expect([...ALLOWED_GET]).toEqual([
      '/deposit/accounts/me',
      '/deposit/transactions',
      '/domains',
      '/contacts/verification/check',
      '/products/info',
      '/products/tlds',
      '/products/ssls',
    ])
    expect([...ALLOWED_POST_READ]).toEqual(['/domains/transfers/query', '/domains/renew/check'])
    expect(PARAMS['/deposit/transactions']).toEqual([
      'StartDate',
      'EndDate',
      'TransactionTypes',
      'ProductTypes',
      'FilterText',
      'TraceId',
      'Sorting',
      'SkipCount',
      'MaxResultCount',
    ])
    expect(PARAMS['/domains']).toEqual(['DomainName', 'SkipCount', 'MaxResultCount'])
    expect(PARAMS['/contacts/verification/check']).toEqual(['HandleCode'])
    expect(PARAMS['/products/info']).toEqual(['ProductName', 'OrderType', 'Period'])
    expect(PARAMS['/deposit/accounts/me']).toEqual([])
  })

  it('sends a GET with the side’s key, in the lane asked for', async () => {
    const { instance, send, lanes } = supplier()
    await instance.get(
      '/deposit/transactions',
      { StartDate: '2026-09-30', SkipCount: 0, TransactionTypes: [1, 5] },
      LOW,
    )
    expect(send).toHaveBeenCalledWith(
      `${SUPPLIER_BASE_URL.ote}/deposit/transactions?StartDate=2026-09-30&SkipCount=0&TransactionTypes=1&TransactionTypes=5`,
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-API-KEY': 'sandbox-key', __reseller: 'reseller-1' },
      }),
    )
    expect(lanes).toEqual([LOW])
  })

  it('refuses any other path, method or parameter — and never sends the reseller’s own filters', async () => {
    const { instance, send } = supplier()
    await expect(instance.get('/domains/register' as never, {}, LOW)).rejects.toThrow(NotAllowed)
    await expect(
      instance.postRead('/domains/renew' as never, { domainName: 'x.com' }, LOW),
    ).rejects.toThrow(NotAllowed)
    await expect(
      instance.postRead('/deposit/transactions' as never, { domainName: 'x.com' }, LOW),
    ).rejects.toThrow(NotAllowed)
    for (const name of ['ResellerId', 'ResellerNames', 'Amount', 'DomainName']) {
      await expect(instance.get('/deposit/transactions', { [name]: 'x' }, LOW)).rejects.toThrow(
        NotAllowed,
      )
    }
    await expect(instance.get('/deposit/accounts/me', { ResellerId: 'x' }, LOW)).rejects.toThrow(
      NotAllowed,
    )
    expect(send).not.toHaveBeenCalled()
    expect(() => buildQuery('/domains', { ResellerNames: ['a'] })).toThrow(
      'parameter ResellerNames',
    )
    expect(buildQuery('/deposit/accounts/me', {})).toBe('')
  })

  it('never asks for the high lane', async () => {
    const { instance, send } = supplier()
    await expect(
      instance.get('/deposit/accounts/me', {}, { priority: 'high' as never, waitMs: 1 }),
    ).rejects.toThrow('the high lane')
    await expect(
      instance.postRead(
        '/domains/transfers/query',
        { domainName: 'x.com' },
        { priority: 'high' as never, waitMs: 1 },
      ),
    ).rejects.toThrow('the high lane')
    expect(send).not.toHaveBeenCalled()
  })

  it('rebuilds a POST body from the name and the period only', async () => {
    const { instance, send } = supplier()
    await instance.postRead(
      '/domains/transfers/query',
      { domainName: 'example.com', period: 3, ResellerId: 'x', authCode: 'secret' } as never,
      LOW,
    )
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: { domainName: 'example.com' },
    })
    expect(JSON.stringify(send.mock.calls[0]?.[1])).not.toContain('secret')
    await instance.postRead('/domains/renew/check', { domainName: 'example.com', period: 2 }, LOW)
    expect(send.mock.calls[1]?.[1]).toMatchObject({
      body: { domainName: 'example.com', period: 2 },
    })
    await expect(
      instance.postRead('/domains/renew/check', { domainName: 'example.com' }, LOW),
    ).rejects.toThrow('without a period')
  })

  it('uses the production host for the live side', async () => {
    const send = vi.fn(async (_url: string, _init?: unknown) => ({ status: 200, body: {} }))
    const live = createAdminSupplier({
      environment: 'production',
      apiKey: 'k',
      resellerId: 'r',
      run: (task) => task(),
      send: send as never,
    })
    await live.get('/deposit/accounts/me', {}, LOW)
    expect(send.mock.calls[0]?.[0]).toBe(`${SUPPLIER_BASE_URL.production}/deposit/accounts/me`)
  })
})

describe('the admin module’s source', () => {
  // D11: no SDK write method, no certificate purchase, no refund — anywhere in admin/.
  it('calls no supplier or Flutterwave write', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const sources = readdirSync(dir)
      .filter(
        (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'test-kit.ts',
      )
      .map((file) => readFileSync(join(dir, file), 'utf8'))
    expect(sources.length).toBeGreaterThan(5)
    const writes =
      /\.(register|renew|transfer|modifyNameServer|ModifyNameServer|RegisterWithContactInfo|Renew|Transfer|SaveContacts|initialize|configure|reissue|createRefund|setLock|setPrivacy|updateContacts|cancelTransfer)\(/
    for (const source of sources) expect(source).not.toMatch(writes)
  })
})
