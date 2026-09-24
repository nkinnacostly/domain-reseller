import { describe, expect, it } from 'vitest'
import { fakeRpcClient } from '../test-support/fake-supabase'
import { createDeepSyncStore } from './deep-sync-store'

/**
 * Records what the store sends and makes of the answers. The functions
 * themselves are checked in supabase/tests/limits_presets_bulk.sql.
 */

const ROW = {
  domain_id: 'd1',
  domain_name: 'example.com',
  local_status: 'active',
  expires_at: '2027-09-23T08:44:10+00:00',
  nameservers: ['ns1.domainnameapi.com'],
  pending_nameservers: null,
  auto_renew: false,
  transfer_lock: true,
  privacy: true,
}

describe('deep sync store', () => {
  it('asks for a batch of due domains on one side, as the reconcile reads ours', async () => {
    const { client, rpc } = fakeRpcClient({
      domains_for_deep_sync: {
        data: [ROW, { ...ROW, domain_id: 'd2', expires_at: null, nameservers: null }],
      },
    })
    await expect(createDeepSyncStore(client).due(false, 25)).resolves.toEqual([
      {
        id: 'd1',
        domainName: 'example.com',
        localStatus: 'active',
        expiresAt: '2027-09-23T08:44:10+00:00',
        nameservers: ['ns1.domainnameapi.com'],
        pendingNameservers: null,
        autoRenew: false,
        transferLock: true,
        privacy: true,
      },
      expect.objectContaining({ id: 'd2', expiresAt: null, nameservers: null }),
    ])
    expect(rpc).toHaveBeenCalledWith('domains_for_deep_sync', { p_test_mode: false, p_limit: 25 })
  })

  it('has nothing due when the function returns nothing', async () => {
    const { client } = fakeRpcClient()
    await expect(createDeepSyncStore(client).due(true, 25)).resolves.toEqual([])
  })

  it('sends a correction in record_reconciliation’s shape, keeping what the answer did not carry', async () => {
    const { client, rpc } = fakeRpcClient()
    await createDeepSyncStore(client).record('d1', false, {
      update: {
        domainId: 'd1',
        registryStatus: 'Active',
        renewalMode: null,
        nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
        events: [
          {
            type: 'nameservers_synced',
            payload: { before: ['ns1.domainnameapi.com'], after: ['ns1.vercel-dns.com'] },
          },
        ],
      },
      findings: [
        {
          domainId: 'd1',
          domainName: 'example.com',
          kind: 'supplier_renewed',
          detail: { ours: 'a', registry: 'b' },
        },
      ],
    })
    expect(rpc).toHaveBeenCalledWith('record_deep_sync', {
      p_domain_id: 'd1',
      p_test_mode: false,
      p_update: {
        registry_status: 'Active',
        renewal_mode: null,
        expires_at: null,
        nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
        transfer_lock: null,
        privacy: null,
        events: [
          {
            type: 'nameservers_synced',
            payload: { before: ['ns1.domainnameapi.com'], after: ['ns1.vercel-dns.com'] },
          },
        ],
      },
      p_findings: [{ kind: 'supplier_renewed', detail: { ours: 'a', registry: 'b' } }],
    })
  })

  it('sends every field it has, and no status when the answer carried none', async () => {
    const { client, rpc } = fakeRpcClient()
    await createDeepSyncStore(client).record('d1', true, {
      update: {
        domainId: 'd1',
        registryStatus: '',
        renewalMode: null,
        expiresAt: '2028-09-23T08:44:10.000Z',
        transferLock: false,
        privacy: true,
        events: [],
      },
      findings: [],
    })
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_test_mode: true,
      p_update: {
        registry_status: null,
        expires_at: '2028-09-23T08:44:10.000Z',
        transfer_lock: false,
        privacy: true,
      },
      p_findings: [],
    })
  })

  it('stamps only when the registry agreed', async () => {
    const { client, rpc } = fakeRpcClient()
    await createDeepSyncStore(client).record('d1', false, { update: null, findings: [] })
    expect(rpc).toHaveBeenCalledWith('record_deep_sync', {
      p_domain_id: 'd1',
      p_test_mode: false,
      p_update: null,
      p_findings: [],
    })
  })

  it('passes database errors on', async () => {
    const error = { message: 'permission denied' }
    const { client } = fakeRpcClient({
      domains_for_deep_sync: { error },
      record_deep_sync: { error },
    })
    const store = createDeepSyncStore(client)
    await expect(store.due(false, 25)).rejects.toThrow('permission denied')
    await expect(store.record('d1', false, { update: null, findings: [] })).rejects.toThrow(
      'permission denied',
    )
  })
})
