import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import type { ProfileRow } from '../lib/profiles'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { listContactProfiles, resolveContactRoles, resolveRoleChoice } = await import(
  '../queries/profiles'
)

const PROFILE_ID = '7d7f7a0e-1c61-4c4f-9f7e-0a6a2f9b1a11'
const ADA = {
  firstName: 'Ada',
  lastName: 'Okafor',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '1 Marina',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}
const ROW: ProfileRow = {
  id: PROFILE_ID,
  label: 'Accounts',
  is_default: false,
  first_name: 'Bola',
  last_name: 'Ade',
  company: null,
  email: 'accounts@example.com',
  phone: '8039876543',
  phone_country_code: '234',
  address_line1: '2 Broad Street',
  address_line2: null,
  city: 'Lagos',
  state: 'Lagos',
  zip_code: '100001',
  country: 'NG',
}

type Answer = { data: unknown; error: { code?: string; message: string } | null }

/** The user's own client (RLS), answering every contact_profiles read with `answer`. */
function client(answer: Answer) {
  const calls: unknown[][] = []
  const query = Object.assign(Promise.resolve(answer), {} as Record<string, unknown>)
  for (const method of ['select', 'eq', 'order', 'limit']) {
    query[method] = (...args: unknown[]) => {
      calls.push([method, ...args])
      return query
    }
  }
  query.maybeSingle = async () => answer
  const supabase = {
    from: (table: string) => {
      calls.push(['from', table])
      return query
    },
  }
  return { supabase: supabase as never, calls }
}

const newDetails = (over: Record<string, string> = {}) => ({
  kind: 'new' as const,
  contact: { ...ADA, firstName: 'Chi', email: 'chi@example.com', ...over },
})

beforeEach(() => vi.restoreAllMocks())

describe('listContactProfiles', () => {
  it('says the profiles could not be read, logging no row (N13)', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const { supabase } = client({ data: null, error: { code: '500', message: 'down' } })
    vi.mocked(createClient).mockResolvedValue(supabase)
    await expect(listContactProfiles()).resolves.toBeNull()
    expect(warn).toHaveBeenCalledWith({ code: '500', err: 'down' }, 'contact profiles not read')
  })

  it('reads the account’s own, default first', async () => {
    const { supabase, calls } = client({ data: [ROW], error: null })
    vi.mocked(createClient).mockResolvedValue(supabase)
    const profiles = await listContactProfiles()
    expect(profiles?.map((profile) => profile.label)).toEqual(['Accounts'])
    expect(calls).toContainEqual(['from', 'contact_profiles'])
    expect(calls).toContainEqual(['order', 'is_default', { ascending: false }])
  })
})

describe('resolveRoleChoice (FR-A4)', () => {
  it('refuses a saved contact it could not read, without logging the row (N13)', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const { supabase } = client({
      data: null,
      error: { code: '500', message: 'down', details: 'Bola Ade' } as never,
    })
    await expect(
      resolveRoleChoice(supabase, { kind: 'profile', profileId: PROFILE_ID }),
    ).resolves.toEqual({
      ok: false,
      error: 'We couldn’t read your saved contacts just now. Try again.',
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Bola')
  })

  it('refuses a saved contact that is not the account’s own (RLS returns nothing)', async () => {
    const { supabase, calls } = client({ data: null, error: null })
    await expect(
      resolveRoleChoice(supabase, { kind: 'profile', profileId: PROFILE_ID }),
    ).resolves.toEqual({
      ok: false,
      error:
        'That saved contact is no longer on your account. Choose another, or enter new details.',
    })
    expect(calls).toContainEqual(['eq', 'id', PROFILE_ID])
  })

  it('refuses a saved contact missing details the registry needs', async () => {
    const { supabase } = client({ data: { ...ROW, city: '' }, error: null })
    await expect(
      resolveRoleChoice(supabase, { kind: 'profile', profileId: PROFILE_ID }),
    ).resolves.toEqual({
      ok: false,
      error:
        'The saved contact “Accounts” is missing details. Complete it in Settings → Contacts, or enter new details.',
    })
    const { supabase: shortPhone } = client({ data: { ...ROW, phone: '123' }, error: null })
    await expect(
      resolveRoleChoice(shortPhone, { kind: 'profile', profileId: PROFILE_ID }),
    ).resolves.toMatchObject({ ok: false })
    // Passes the form's checks, but is longer than E.164 allows.
    const { supabase: longPhone } = client({
      data: { ...ROW, phone: '8031234567890123' },
      error: null,
    })
    await expect(
      resolveRoleChoice(longPhone, { kind: 'profile', profileId: PROFILE_ID }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/missing details/) })
  })

  it('refuses new details whose phone number the registry would not take', async () => {
    const { supabase } = client({ data: null, error: null })
    await expect(
      resolveRoleChoice(supabase, newDetails({ phone: '1234567890123456' })),
    ).resolves.toEqual({
      ok: false,
      error: 'Check the phone number: it should be 4 to 15 digits after the code.',
    })
  })

  it('takes the saved contact as the database holds it, never the browser’s copy', async () => {
    const { supabase } = client({ data: ROW, error: null })
    await expect(
      resolveRoleChoice(supabase, { kind: 'profile', profileId: PROFILE_ID }),
    ).resolves.toEqual({
      ok: true,
      contact: expect.objectContaining({ firstName: 'Bola', phone: '8039876543' }),
    })
  })

  it('normalises new details like the registrant’s, and reads nothing for the registrant', async () => {
    const { supabase, calls } = client({ data: null, error: null })
    await expect(resolveRoleChoice(supabase, { kind: 'registrant' })).resolves.toEqual({
      ok: true,
      contact: null,
    })
    await expect(
      resolveRoleChoice(supabase, newDetails({ phone: '0803 555 0000' })),
    ).resolves.toEqual({
      ok: true,
      contact: expect.objectContaining({ firstName: 'Chi', phone: '8035550000' }),
    })
    expect(calls).toEqual([])
  })
})

describe('resolveContactRoles (FR-C5, FR-A4)', () => {
  it('names the role that failed, and stops there', async () => {
    const { supabase } = client({ data: null, error: null })
    await expect(
      resolveContactRoles(
        supabase,
        { technical: newDetails(), billing: { kind: 'profile', profileId: PROFILE_ID } },
        ADA,
      ),
    ).resolves.toEqual({
      ok: false,
      role: 'billing',
      error:
        'Billing contact: That saved contact is no longer on your account. Choose another, or enter new details.',
    })
  })

  it('keeps only the roles someone other than the registrant holds', async () => {
    const { supabase } = client({ data: ROW, error: null })
    const resolved = await resolveContactRoles(
      supabase,
      {
        administrative: { kind: 'registrant' },
        technical: { kind: 'new', contact: ADA },
        billing: { kind: 'profile', profileId: PROFILE_ID },
      },
      ADA,
    )
    expect(resolved).toEqual({
      ok: true,
      contacts: { billing: expect.objectContaining({ firstName: 'Bola' }) },
    })
  })

  it('has nothing to keep when no roles were sent', async () => {
    const { supabase } = client({ data: null, error: null })
    await expect(resolveContactRoles(supabase, undefined, ADA)).resolves.toEqual({
      ok: true,
      contacts: {},
    })
  })
})
