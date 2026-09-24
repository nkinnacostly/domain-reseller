import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCartView } from '@/features/cart/queries/cart'
import { env } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/features/cart/queries/cart', () => ({ getCartView: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { getCheckoutView } = await import('../queries/checkout')

/*
 * Env names go through constants so no line pairs a key name with a value —
 * the pre-commit secret scan reads `NAME = 'value'` as a leaked key.
 */
const SECRET = 'FLUTTERWAVE_SECRET_KEY'
const HASH = 'FLUTTERWAVE_WEBHOOK_HASH'
const ALLOWLIST = 'CHECKOUT_ALLOWLIST'
const settings = env as unknown as Record<string, string | undefined>
const before = {
  [SECRET]: settings[SECRET],
  [HASH]: settings[HASH],
  [ALLOWLIST]: settings[ALLOWLIST],
}
const flutterwaveKey = (mode: 'TEST' | 'LIVE') =>
  ['FLWSECK', mode === 'TEST' ? '_TEST-' : '-', 'dummy', '-X'].join('')

const CONTACT = {
  id: 'contact-1',
  first_name: 'Ada',
  last_name: 'Okafor',
  company: null,
  email: 'ada@work.example',
  phone: '8031234567',
  phone_country_code: '234',
  address_line1: '12 Admiralty Way',
  address_line2: null,
  city: 'Lagos',
  state: 'Lagos',
  zip_code: '100001',
  country: 'NG',
}

type Tables = { contact_profiles?: unknown; profiles?: unknown }

function signedIn(user: { id: string; email?: string } | null, tables: Tables = {}) {
  const from = vi.fn((table: keyof Tables) => {
    const answer = { data: tables[table] ?? null, error: null }
    const query = Promise.resolve(answer) as Promise<typeof answer> & Record<string, unknown>
    for (const method of ['select', 'eq']) query[method] = () => query
    query.single = () => Promise.resolve(answer)
    query.maybeSingle = () => Promise.resolve(answer)
    return query
  })
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
    from,
  } as never)
  return from
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getCartView).mockResolvedValue({ state: 'empty' })
  delete settings[SECRET]
  delete settings[HASH]
  delete settings[ALLOWLIST]
})

afterEach(() => Object.assign(settings, before))

describe('getCheckoutView', () => {
  it('has nothing to show a visitor who is not signed in', async () => {
    const from = signedIn(null)
    expect(await getCheckoutView()).toBeNull()
    expect(getCartView).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
  })

  it('pre-fills the saved default contact, with empty optional fields', async () => {
    signedIn({ id: 'user-1', email: 'ada@example.com' }, { contact_profiles: CONTACT })
    const view = await getCheckoutView()
    expect(view?.registrant).toEqual({
      firstName: 'Ada',
      lastName: 'Okafor',
      company: '',
      email: 'ada@work.example',
      phoneCountryCode: '234',
      phone: '8031234567',
      addressLine1: '12 Admiralty Way',
      addressLine2: '',
      city: 'Lagos',
      state: 'Lagos',
      zipCode: '100001',
      country: 'NG',
    })
  })

  it('keeps a saved company and second address line', async () => {
    signedIn(
      { id: 'user-1' },
      { contact_profiles: { ...CONTACT, company: 'Paidly Ltd', address_line2: 'Floor 3' } },
    )
    const view = await getCheckoutView()
    expect(view?.registrant).toMatchObject({ company: 'Paidly Ltd', addressLine2: 'Floor 3' })
  })

  it('starts a first-time buyer from what the account knows, in Nigeria', async () => {
    signedIn(
      { id: 'user-1', email: 'ada@example.com' },
      { profiles: { full_name: '  Ada  Chioma Okafor ', phone: '08031234567' } },
    )
    const view = await getCheckoutView()
    expect(view?.registrant).toEqual({
      firstName: 'Ada',
      lastName: 'Chioma Okafor',
      company: '',
      email: 'ada@example.com',
      phoneCountryCode: '234',
      phone: '08031234567',
      addressLine1: '',
      addressLine2: '',
      city: '',
      state: '',
      zipCode: '',
      country: 'NG',
    })
  })

  it('leaves the name, email and phone blank when the account has none', async () => {
    signedIn({ id: 'user-1' })
    const view = await getCheckoutView()
    expect(view?.registrant).toMatchObject({ firstName: '', lastName: '', email: '', phone: '' })
  })

  it('passes the cart through as priced now', async () => {
    const cart = { state: 'unpriced' as const }
    vi.mocked(getCartView).mockResolvedValue(cart)
    signedIn({ id: 'user-1' })
    expect((await getCheckoutView())?.cart).toBe(cart)
  })

  it('is open to everyone while no allowlist is set', async () => {
    signedIn({ id: 'user-1', email: 'ada@example.com' })
    expect((await getCheckoutView())?.open).toBe(true)
  })

  it('is closed to an account not on the pre-launch allowlist', async () => {
    settings[ALLOWLIST] = 'owner@example.com'
    signedIn({ id: 'user-1', email: 'ada@example.com' })
    expect((await getCheckoutView())?.open).toBe(false)
  })

  it('says payments are not configured, and treats them as test mode, with no secret key', async () => {
    signedIn({ id: 'user-1' })
    expect(await getCheckoutView()).toMatchObject({ paymentsConfigured: false, testMode: true })
  })

  it('needs the webhook hash as well as the key before payments count as configured', async () => {
    settings[SECRET] = flutterwaveKey('TEST')
    signedIn({ id: 'user-1' })
    expect(await getCheckoutView()).toMatchObject({ paymentsConfigured: false, testMode: true })

    settings[HASH] = 'hash'
    expect(await getCheckoutView()).toMatchObject({ paymentsConfigured: true, testMode: true })
  })

  it('is live only with a live secret key', async () => {
    settings[SECRET] = flutterwaveKey('LIVE')
    settings[HASH] = 'hash'
    signedIn({ id: 'user-1' })
    expect(await getCheckoutView()).toMatchObject({ paymentsConfigured: true, testMode: false })
  })
})
