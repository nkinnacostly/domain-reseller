import { describe, expect, it } from 'vitest'
import { fakeRpcClient } from '../test-support/fake-supabase'
import { createPresetStore, type PresetCheckDetail } from './store'

/**
 * Records what the store sends and makes of the answers. The functions
 * themselves are checked in supabase/tests/limits_presets_bulk.sql.
 */

const DETAIL: PresetCheckDetail = {
  unresolved: ['ns2.host.test'],
  hosts: [
    {
      host: 'ns2.host.test',
      verdict: 'fails',
      views: [
        { resolver: 'Cloudflare', state: 'nxdomain' },
        { resolver: 'Google', state: 'nxdomain' },
      ],
    },
  ],
}

describe('preset store', () => {
  it('reads the presets due a check', async () => {
    const { client, rpc } = fakeRpcClient({
      presets_for_check: {
        data: [
          { preset_id: 'p1', provider: 'Vercel', nameservers: ['ns1.vercel-dns.com'] },
          { preset_id: 'p2', provider: 'Odd', nameservers: null },
        ],
      },
    })
    await expect(createPresetStore(client).due()).resolves.toEqual([
      { id: 'p1', provider: 'Vercel', nameservers: ['ns1.vercel-dns.com'] },
      { id: 'p2', provider: 'Odd', nameservers: [] },
    ])
    expect(rpc).toHaveBeenCalledWith('presets_for_check')
  })

  it('has nothing due when the function returns nothing', async () => {
    const { client } = fakeRpcClient()
    await expect(createPresetStore(client).due()).resolves.toEqual([])
  })

  it('records a verdict with what was seen, and returns what the database made of it', async () => {
    const { client, rpc } = fakeRpcClient({ record_preset_check: { data: 'failing' } })
    await expect(createPresetStore(client).record('p1', false, DETAIL)).resolves.toBe('failing')
    expect(rpc).toHaveBeenCalledWith('record_preset_check', {
      p_preset_id: 'p1',
      p_ok: false,
      p_detail: DETAIL,
    })
  })

  it('refuses an answer it does not know', async () => {
    const { client } = fakeRpcClient({ record_preset_check: { data: 'deleted' } })
    await expect(createPresetStore(client).record('p1', true, DETAIL)).rejects.toThrow(
      'record_preset_check answered "deleted"',
    )
    const empty = fakeRpcClient()
    await expect(createPresetStore(empty.client).record('p1', true, DETAIL)).rejects.toThrow(
      'answered null',
    )
  })

  it('passes database errors on', async () => {
    const error = { message: 'permission denied' }
    const { client } = fakeRpcClient({
      presets_for_check: { error },
      record_preset_check: { error },
    })
    const store = createPresetStore(client)
    await expect(store.due()).rejects.toThrow('permission denied')
    await expect(store.record('p1', true, DETAIL)).rejects.toThrow('permission denied')
  })
})

describe('preset drafts (ADMIN-SPEC D21)', () => {
  it('reads the open drafts due a check, and nothing from an odd answer', async () => {
    const { client, rpc } = fakeRpcClient({
      preset_drafts_for_check: {
        data: [
          { draft_id: 'd1', provider: 'Vercel', nameservers: ['ns1.vercel-dns.com'] },
          { draft_id: 'd2', provider: 'Odd', nameservers: null },
        ],
      },
    })
    expect(await createPresetStore(client).dueDrafts?.()).toEqual([
      { id: 'd1', provider: 'Vercel', nameservers: ['ns1.vercel-dns.com'] },
      { id: 'd2', provider: 'Odd', nameservers: [] },
    ])
    expect(rpc.mock.calls[0]?.[0]).toBe('preset_drafts_for_check')
    const odd = fakeRpcClient({ preset_drafts_for_check: { data: 'ok' } })
    expect(await createPresetStore(odd.client).dueDrafts?.()).toEqual([])
  })

  it('records a draft’s verdict on the draft, and refuses an answer it does not know', async () => {
    const { client, rpc } = fakeRpcClient({ record_preset_draft_check: { data: 'failing' } })
    expect(await createPresetStore(client).recordDraft?.('d1', false, DETAIL)).toBe('failing')
    expect(rpc).toHaveBeenCalledWith('record_preset_draft_check', {
      p_draft_id: 'd1',
      p_ok: false,
      p_detail: DETAIL,
    })
    const odd = fakeRpcClient({ record_preset_draft_check: { data: 'hidden' } })
    await expect(createPresetStore(odd.client).recordDraft?.('d1', true, DETAIL)).rejects.toThrow(
      'answered "hidden"',
    )
    const refused = fakeRpcClient({
      preset_drafts_for_check: { error: { message: 'denied' } },
      record_preset_draft_check: { error: { message: 'denied' } },
    })
    await expect(createPresetStore(refused.client).dueDrafts?.()).rejects.toThrow('denied')
    await expect(
      createPresetStore(refused.client).recordDraft?.('d1', true, DETAIL),
    ).rejects.toThrow('denied')
  })
})
