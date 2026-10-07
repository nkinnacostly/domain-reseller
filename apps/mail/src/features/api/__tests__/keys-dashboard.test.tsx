import { hashApiKey, isApiKey } from '@dr/shared/mail'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { revalidatePath } from 'next/cache'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'

/**
 * API keys in the dashboard (MAIL-SPEC §10, MR7): who may make and revoke
 * what, the key shown once and put away only once it is saved, and that
 * only its hash reaches the database.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

const { createApiKey, revokeApiKey } = await import('../actions/keys')
const { canRevoke, canSeeKeys, keyRefusal, permissionsFor } = await import('../lib/keys')
const { getKeyDomains, getKeys } = await import('../queries/keys')

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const KEY_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const DOMAIN = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'
const PEPPER = 'test pepper, not a secret, 0123456789'

type Answer = { data: unknown; error: { code: string } | null }

function session({
  role = 'owner',
  rpc = {} as Record<string, Answer>,
  tables = {} as Record<string, Answer>,
} = {}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = []
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = (table: string) => {
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'neq', 'order']) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ table, method, args })
        return chain
      }
    }
    chain.maybeSingle = async () =>
      table === 'members'
        ? { data: { role }, error: null }
        : (tables[table] ?? { data: null, error: null })
    // biome-ignore lint/suspicious/noThenProperty: a PostgREST builder is awaited
    chain.then = (resolve: (value: Answer) => unknown) =>
      Promise.resolve(tables[table] ?? { data: [], error: null }).then(resolve)
    return chain
  }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return rpc[fn] ?? { data: null, error: { code: 'PGRST202' } }
    },
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return { rpcCalls, calls }
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})
beforeEach(() => vi.clearAllMocks())

describe('who may do what with keys', () => {
  it('mirrors SQL: owners and admins any key, developers sending keys, viewers none', () => {
    expect(permissionsFor('owner')).toEqual(['sending', 'full'])
    expect(permissionsFor('admin')).toEqual(['sending', 'full'])
    expect(permissionsFor('developer')).toEqual(['sending'])
    expect(permissionsFor('viewer')).toEqual([])
    expect(canRevoke('developer', 'full')).toBe(false)
    expect(canRevoke('developer', 'sending')).toBe(true)
    expect(canSeeKeys('viewer')).toBe(false)
    expect(canSeeKeys('developer')).toBe(true)
  })

  it('words SQL’s refusals, and never shows a raw code', () => {
    expect(keyRefusal({ code: 'forbidden' })).toContain('Developers make and revoke sending keys')
    expect(keyRefusal({ code: 'validation', field: 'domain' })).toContain('not in this account')
    expect(keyRefusal({ code: 'validation', field: 'odd' })).toContain('Nothing was changed')
    expect(keyRefusal({ code: 'xx' })).toContain('Nothing was changed')
    // Migration 54 (review 13): the account's live keys are capped.
    expect(keyRefusal({ code: 'key_limit', max: 50 })).toContain('has 50 live keys')
    expect(keyRefusal({ code: 'key_limit' })).toContain('the most live keys')
    expect(keyRefusal(null)).toContain('Nothing was changed')
  })
})

describe('createApiKey', () => {
  it('makes a key, sends SQL only its prefix and hash, and hands the key back once', async () => {
    const { rpcCalls } = session({
      rpc: { create_api_key: { data: { ok: true, keyId: KEY_ID }, error: null } },
    })
    const result = await createApiKey({
      accountId: ACCOUNT,
      name: ' Shop receipts ',
      permission: 'sending',
      domainId: DOMAIN,
    })
    const created = result?.data as { key: string; prefix: string; name: string }
    expect(isApiKey(created.key)).toBe(true)
    expect(created).toMatchObject({ name: 'Shop receipts', permission: 'sending' })
    expect(rpcCalls).toEqual([
      {
        fn: 'create_api_key',
        args: {
          p_account_id: ACCOUNT,
          p_name: 'Shop receipts',
          p_permission: 'sending',
          p_prefix: created.prefix,
          p_key_hash: await hashApiKey(created.key, PEPPER),
          p_domain_id: DOMAIN,
        },
      },
    ])
    expect(JSON.stringify(rpcCalls)).not.toContain(created.key)
  })

  it('refuses a developer a full-access key before asking SQL', async () => {
    const { rpcCalls } = session({ role: 'developer' })
    const result = await createApiKey({ accountId: ACCOUNT, name: 'x', permission: 'full' })
    expect(result?.data).toEqual({ error: expect.stringContaining('Developers make') })
    expect(rpcCalls).toEqual([])
  })

  it('refuses a domain on a full key, and a viewer altogether', async () => {
    session()
    const limited = await createApiKey({
      accountId: ACCOUNT,
      name: 'x',
      permission: 'full',
      domainId: DOMAIN,
    })
    expect(limited?.validationErrors).toBeDefined()
    session({ role: 'viewer' })
    const viewer = await createApiKey({ accountId: ACCOUNT, name: 'x', permission: 'sending' })
    expect(viewer?.serverError).toContain('Your role')
  })

  it('words SQL’s refusal, and fails loudly when the database does', async () => {
    session({
      rpc: {
        create_api_key: { data: { ok: false, code: 'validation', field: 'domain' }, error: null },
      },
    })
    expect(
      (await createApiKey({ accountId: ACCOUNT, name: 'x', permission: 'sending' }))?.data,
    ).toEqual({ error: expect.stringContaining('not in this account') })
    session({ rpc: { create_api_key: { data: null, error: { code: '08006' } } } })
    expect(
      (await createApiKey({ accountId: ACCOUNT, name: 'x', permission: 'sending' }))?.serverError,
    ).toBeTruthy()
  })
})

describe('revokeApiKey', () => {
  it('revokes through SQL and refreshes the page', async () => {
    const { rpcCalls } = session({
      rpc: { revoke_api_key: { data: { ok: true, keyId: KEY_ID }, error: null } },
    })
    expect((await revokeApiKey({ accountId: ACCOUNT, keyId: KEY_ID }))?.data).toEqual({ ok: true })
    expect(rpcCalls).toEqual([{ fn: 'revoke_api_key', args: { p_key_id: KEY_ID } }])
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/api-keys')
  })

  it('words a refusal, and fails loudly when the database does', async () => {
    session({ rpc: { revoke_api_key: { data: { ok: false, code: 'forbidden' }, error: null } } })
    expect((await revokeApiKey({ accountId: ACCOUNT, keyId: KEY_ID }))?.data).toEqual({
      error: expect.stringContaining('Your role'),
    })
    session({ rpc: { revoke_api_key: { data: null, error: { code: '08006' } } } })
    expect((await revokeApiKey({ accountId: ACCOUNT, keyId: KEY_ID }))?.serverError).toBeTruthy()
  })
})

describe('the keys page’s reads', () => {
  it('reads keys newest first without any secret column, and domains that are not removed', async () => {
    const { calls } = session({
      tables: {
        api_keys: {
          data: [
            {
              id: KEY_ID,
              name: 'Shop',
              prefix: 'mdh_live_Ab12',
              permission: 'sending',
              domain_id: null,
              created_at: '2026-10-06T09:00:00Z',
              last_used_at: null,
              revoked_at: null,
            },
            { id: 'odd', permission: 'admin' },
          ],
          error: null,
        },
        domains: { data: [{ id: DOMAIN, name: 'acme.example', status: 'verified' }], error: null },
      },
    })
    expect(await getKeys(ACCOUNT)).toEqual([
      {
        id: KEY_ID,
        name: 'Shop',
        prefix: 'mdh_live_Ab12',
        permission: 'sending',
        domainId: null,
        createdAt: '2026-10-06T09:00:00Z',
        lastUsedAt: null,
        revokedAt: null,
      },
    ])
    expect(await getKeyDomains(ACCOUNT)).toEqual([
      { id: DOMAIN, name: 'acme.example', status: 'verified' },
    ])
    const select = calls.find((call) => call.table === 'api_keys' && call.method === 'select')
    expect(String(select?.args[0])).not.toContain('hash')
    expect(calls).toContainEqual({ table: 'domains', method: 'neq', args: ['status', 'removed'] })
  })

  it('is null when a read fails', async () => {
    session({
      tables: {
        api_keys: { data: null, error: { code: '42501' } },
        domains: { data: null, error: { code: '42501' } },
      },
    })
    expect(await getKeys(ACCOUNT)).toBeNull()
    expect(await getKeyDomains(ACCOUNT)).toBeNull()
  })
})

describe('the key forms', () => {
  it('shows the new key once: copy it, say it is saved, and only then put it away', async () => {
    const { CreateKeyForm } = await import('../components/create-key-form')
    session({ rpc: { create_api_key: { data: { ok: true, keyId: KEY_ID }, error: null } } })
    const user = userEvent.setup()
    render(
      <CreateKeyForm
        accountId={ACCOUNT}
        memberRole="owner"
        domains={[
          { id: DOMAIN, name: 'acme.example', status: 'verified' },
          { id: 'd2', name: 'new.example', status: 'pending' },
        ]}
      />,
    )
    const form = screen.getByRole('form', { name: 'Make an API key' })
    expect(within(form).getByRole('option', { name: 'new.example (pending)' })).toBeInTheDocument()
    await user.click(within(form).getByRole('radio', { name: /Full access/ }))
    expect(within(form).queryByLabelText('Domain')).toBeNull()
    await user.click(within(form).getByRole('radio', { name: /Sending only/ }))
    await user.type(within(form).getByLabelText('Name'), 'Shop receipts')
    await user.selectOptions(within(form).getByLabelText('Domain'), DOMAIN)
    await user.click(within(form).getByRole('button', { name: 'Make the key' }))

    const key = await screen.findByLabelText('Your API key')
    expect(isApiKey((key as HTMLInputElement).value)).toBe(true)
    expect(screen.getByText(/This is the only time it is shown/)).toBeInTheDocument()
    const done = screen.getByRole('button', { name: 'Done' })
    expect(done).toBeDisabled()

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await user.click(screen.getByRole('button', { name: 'Copy key' }))
    expect(writeText).toHaveBeenCalledWith((key as HTMLInputElement).value)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'I have saved it' }))
    await user.click(done)
    expect(router.refresh).toHaveBeenCalled()
    expect(screen.queryByLabelText('Your API key')).toBeNull()
    expect(screen.getByRole('form', { name: 'Make an API key' })).toBeInTheDocument()
  })

  it('says when copying does not work, and offers a developer sending keys only', async () => {
    const { NewKeyPanel, CreateKeyForm } = await import('../components/create-key-form')
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    const { unmount } = render(
      <NewKeyPanel
        created={{ key: 'mdh_live_x', prefix: 'mdh_live_x', name: 'x', permission: 'full' }}
        onDone={() => undefined}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Copy key' }))
    expect(screen.getByText(/Copying did not work here/)).toBeInTheDocument()
    unmount()
    render(<CreateKeyForm accountId={ACCOUNT} memberRole="developer" domains={[]} />)
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(screen.getByText(/Developers make sending keys/)).toBeInTheDocument()
  })

  it('shows SQL’s refusal in the form, and keeps what was typed', async () => {
    const { CreateKeyForm } = await import('../components/create-key-form')
    session({
      rpc: { create_api_key: { data: { ok: false, code: 'account_closed' }, error: null } },
    })
    const user = userEvent.setup()
    render(<CreateKeyForm accountId={ACCOUNT} memberRole="admin" domains={[]} />)
    await user.type(screen.getByLabelText('Name'), 'Billing')
    await user.click(screen.getByRole('button', { name: 'Make the key' }))
    expect(await screen.findByText(/This account is closed/)).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Billing')
  })

  it('lists keys with their facts, and revokes one after asking', async () => {
    const { KeysList } = await import('../components/keys-list')
    session({ rpc: { revoke_api_key: { data: { ok: true, keyId: KEY_ID }, error: null } } })
    const user = userEvent.setup()
    render(
      <KeysList
        accountId={ACCOUNT}
        memberRole="developer"
        domains={[{ id: DOMAIN, name: 'acme.example', status: 'verified' }]}
        keys={[
          {
            id: KEY_ID,
            name: 'Shop',
            prefix: 'mdh_live_Ab12',
            permission: 'sending',
            domainId: DOMAIN,
            createdAt: '2026-10-06T09:00:00Z',
            lastUsedAt: '2026-10-06T10:30:00Z',
            revokedAt: null,
          },
          {
            id: 'k2',
            name: 'Admin',
            prefix: 'mdh_live_Cd34',
            permission: 'full',
            domainId: 'gone',
            createdAt: '2026-10-06T09:00:00Z',
            lastUsedAt: null,
            revokedAt: null,
          },
        ]}
      />,
    )
    const shop = screen.getByText('Shop').closest('li') as HTMLElement
    expect(shop).toHaveTextContent('mdh_live_Ab12…')
    expect(shop).toHaveTextContent('Sending only')
    expect(shop).toHaveTextContent('Only acme.example')
    expect(shop).toHaveTextContent('last used 6 Oct 2026, 11:30')
    const admin = screen.getByText('Admin').closest('li') as HTMLElement
    expect(admin).toHaveTextContent('never used')
    expect(admin).toHaveTextContent('Only a removed domain')
    // A developer cannot revoke a full-access key.
    expect(within(admin).queryByRole('button')).toBeNull()

    await user.click(within(shop).getByRole('button', { name: 'Revoke the key Shop' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Requests with mdh_live_Ab12… are refused from now on')
    await user.click(within(dialog).getByRole('button', { name: 'Revoke the key' }))
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled())
  })

  it('marks a revoked key and offers nothing to do with it', async () => {
    const { KeysList } = await import('../components/keys-list')
    render(
      <KeysList
        accountId={ACCOUNT}
        memberRole="owner"
        domains={[]}
        keys={[
          {
            id: KEY_ID,
            name: 'Old',
            prefix: 'mdh_live_Zz99',
            permission: 'full',
            domainId: null,
            createdAt: '2026-10-01T09:00:00Z',
            lastUsedAt: '2026-10-02T09:00:00Z',
            revokedAt: '2026-10-03T09:00:00Z',
          },
        ]}
      />,
    )
    const item = screen.getByText('Old').closest('li') as HTMLElement
    expect(item).toHaveTextContent('Revoked')
    expect(item).toHaveTextContent('revoked 3 Oct 2026, 10:00')
    expect(within(item).queryByRole('button')).toBeNull()
  })
})
