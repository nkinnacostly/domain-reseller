import { revalidatePath } from 'next/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { deleteContactProfile, makeDefaultContactProfile, saveContactProfile } = await import(
  '../actions/profiles'
)

const PROFILE_ID = '7d7f7a0e-1c61-4c4f-9f7e-0a6a2f9b1a11'
const CONTACT = {
  firstName: 'Bola',
  lastName: 'Ade',
  company: '',
  email: 'accounts@example.com',
  phoneCountryCode: '234',
  phone: '0803 987 6543',
  addressLine1: '2 Broad Street',
  addressLine2: '',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}

type Answer = { data?: unknown; error: { code?: string; message: string } | null; count?: number }
type Write = { op: string; row?: unknown; filters: unknown[][] }

/**
 * The signed-in user's own client (RLS). Each call to `from` takes the next
 * answer from `answers`; every write is recorded with its filters.
 */
function userClient(answers: Answer[]) {
  const writes: Write[] = []
  const queue = [...answers]
  const from = vi.fn(() => {
    const answer = queue.shift() ?? { data: null, error: null }
    let write: Write | null = null
    const node: Record<string, unknown> = {}
    const settle = () => Promise.resolve(answer)
    Object.assign(node, {
      // biome-ignore lint/suspicious/noThenProperty: a thenable query double, like PostgREST's builder
      then: (resolve: (value: Answer) => unknown) => settle().then(resolve),
      select: () => node,
      order: () => node,
      eq: (...args: unknown[]) => {
        write?.filters.push(['eq', ...args])
        return node
      },
      maybeSingle: settle,
      single: settle,
    })
    for (const op of ['insert', 'update', 'delete']) {
      node[op] = (row?: unknown) => {
        write = { op, row, filters: [] }
        writes.push(write)
        return node
      }
    }
    return node
  })
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from,
  } as never)
  return { writes, from }
}

const save = (over: Record<string, unknown> = {}) =>
  saveContactProfile({ label: 'Accounts', contact: CONTACT, isDefault: false, ...over })

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('saveContactProfile (FR-A4)', () => {
  it('refuses a phone number the registry would not take, saving nothing', async () => {
    const { writes } = userClient([])
    expect((await save({ contact: { ...CONTACT, phone: '1234567890123456' } }))?.data).toEqual({
      error: 'Check the phone number: it should be 4 to 15 digits after the code.',
    })
    expect(writes).toEqual([])
  })

  it('refuses a new profile once the account holds the most it may', async () => {
    const { writes } = userClient([{ count: 25, error: null }])
    expect((await save())?.data).toEqual({
      error: 'You can save up to 25 contacts. Delete one you no longer use, then add this one.',
    })
    expect(writes).toEqual([])
  })

  it('says so when the profiles cannot be counted, and logs no details (N13)', async () => {
    const warn = vi.spyOn(logger, 'warn')
    userClient([{ error: { code: '500', message: 'down' } }])
    expect((await save())?.data).toEqual({ error: 'That could not be saved. Please try again.' })
    expect(warn).toHaveBeenCalledWith({ code: '500', err: 'down' }, 'contact profiles not counted')
  })

  it('says so when the default cannot be moved, and saves nothing else', async () => {
    const { writes } = userClient([
      { count: 1, error: null },
      { error: { code: '500', message: 'down' } },
    ])
    expect((await save({ isDefault: true }))?.data).toEqual({
      error: 'That could not be saved. Please try again.',
    })
    expect(writes.map((write) => write.op)).toEqual(['update'])
  })

  it('says so when the row is refused', async () => {
    userClient([{ count: 1, error: null }, { error: { code: '23514', message: 'check' } }])
    expect((await save())?.data).toEqual({ error: 'That could not be saved. Please try again.' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('adds a profile as the user, with the phone in E.164 parts', async () => {
    const { writes } = userClient([
      { count: 3, error: null },
      { data: { id: 'p-1' }, error: null },
    ])
    expect((await save())?.data).toEqual({ ok: true })
    expect(writes).toEqual([
      {
        op: 'insert',
        row: expect.objectContaining({
          user_id: 'user-1',
          label: 'Accounts',
          is_default: false,
          phone: '8039876543',
          phone_country_code: '234',
          company: null,
        }),
        filters: [],
      },
    ])
    expect(revalidatePath).toHaveBeenCalledWith('/app/settings/contacts')
  })

  it('takes the default from any other profile before making this one the default', async () => {
    const { writes } = userClient([{ error: null }, { data: { id: PROFILE_ID }, error: null }])
    expect((await save({ id: PROFILE_ID, isDefault: true }))?.data).toEqual({ ok: true })
    expect(writes).toEqual([
      {
        op: 'update',
        row: { is_default: false },
        filters: [
          ['eq', 'user_id', 'user-1'],
          ['eq', 'is_default', true],
        ],
      },
      {
        op: 'update',
        row: expect.objectContaining({ label: 'Accounts', is_default: true }),
        filters: [['eq', 'id', PROFILE_ID]],
      },
    ])
  })

  it('says a profile that is not the account’s own is gone (RLS updates nothing)', async () => {
    userClient([{ data: null, error: null }])
    expect((await save({ id: PROFILE_ID }))?.data).toEqual({
      error: 'That contact is no longer on your account. Reload the page to see your contacts.',
    })
  })
})

describe('makeDefaultContactProfile (FR-A4)', () => {
  it('refuses a profile that is not the account’s own', async () => {
    const { writes } = userClient([{ data: null, error: null }])
    expect((await makeDefaultContactProfile({ id: PROFILE_ID }))?.data).toEqual({
      error: 'That contact is no longer on your account. Reload the page to see your contacts.',
    })
    expect(writes).toEqual([])
  })

  it('says so at each step that fails', async () => {
    userClient([{ error: { message: 'down' } }])
    expect((await makeDefaultContactProfile({ id: PROFILE_ID }))?.data).toEqual({
      error: 'That could not be saved. Please try again.',
    })
    userClient([{ data: { id: PROFILE_ID }, error: null }, { error: { message: 'down' } }])
    expect((await makeDefaultContactProfile({ id: PROFILE_ID }))?.data).toHaveProperty('error')
    userClient([
      { data: { id: PROFILE_ID }, error: null },
      { error: null },
      { error: { message: 'unique' } },
    ])
    expect((await makeDefaultContactProfile({ id: PROFILE_ID }))?.data).toHaveProperty('error')
  })

  it('clears the old default, then sets the new one', async () => {
    const { writes } = userClient([{ data: { id: PROFILE_ID }, error: null }])
    expect((await makeDefaultContactProfile({ id: PROFILE_ID }))?.data).toEqual({ ok: true })
    expect(writes.map((write) => write.row)).toEqual([{ is_default: false }, { is_default: true }])
    expect(revalidatePath).toHaveBeenCalledWith('/app/settings/contacts')
  })
})

describe('deleteContactProfile (FR-A4)', () => {
  it('says so when the delete fails', async () => {
    userClient([{ error: { message: 'down' } }])
    expect((await deleteContactProfile({ id: PROFILE_ID }))?.data).toEqual({
      error: 'That could not be saved. Please try again.',
    })
  })

  it('says a profile already gone, or not the account’s own, is gone', async () => {
    userClient([{ data: [], error: null }])
    expect((await deleteContactProfile({ id: PROFILE_ID }))?.data).toEqual({
      error: 'That contact is no longer on your account. Reload the page to see your contacts.',
    })
  })

  it('deletes the profile as the user', async () => {
    const { writes } = userClient([{ data: [{ id: PROFILE_ID }], error: null }])
    expect((await deleteContactProfile({ id: PROFILE_ID }))?.data).toEqual({ ok: true })
    expect(writes).toEqual([{ op: 'delete', row: undefined, filters: [['eq', 'id', PROFILE_ID]] }])
  })

  it('needs a signed-in user', async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    } as never)
    expect((await deleteContactProfile({ id: PROFILE_ID }))?.serverError).toBe(
      'Please sign in to continue.',
    )
  })
})
