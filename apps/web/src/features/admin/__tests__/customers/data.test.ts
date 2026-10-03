import { describe, expect, it } from 'vitest'
import {
  parseContact,
  parseCustomer,
  parseCustomerStats,
  parseFoundCustomers,
  toCustomerRow,
} from '@/features/admin/lib/customers-data'
import { customerJson, customerRow, ids } from './fake-db'

/**
 * What the customers pages read, checked before it is shown (ADMIN-SPEC
 * §3.1.2, §3.2h). An answer that does not parse is unreadable, never half
 * shown; only a reveal carries an unmasked contact.
 */

describe('parseCustomerStats', () => {
  it('reads the totals and the 30 days of sign-ups', () => {
    expect(
      parseCustomerStats({
        profiles: 7,
        confirmed: 6,
        liveBuyers: 2,
        mfaUsers: 1,
        holders: 2,
        active30d: 5,
        over10NoMfa: 0,
        signupsByDay: [{ day: '2026-10-01', count: 2 }],
      }),
    ).toEqual({
      profiles: 7,
      confirmed: 6,
      liveBuyers: 2,
      mfaUsers: 1,
      holders: 2,
      active30d: 5,
      over10NoMfa: 0,
      signupsByDay: [{ day: '2026-10-01', count: 2 }],
    })
  })

  it('reads a count it cannot use as zero, and a missing day list as none', () => {
    expect(parseCustomerStats({ profiles: 'x', confirmed: -1 })).toMatchObject({
      profiles: 0,
      confirmed: 0,
      signupsByDay: [],
    })
  })

  it('refuses an answer that is not an object', () => {
    expect(parseCustomerStats(null)).toBeNull()
    expect(parseCustomerStats('7')).toBeNull()
  })
})

describe('toCustomerRow', () => {
  it('puts a list row in the page’s shape, money in kobo', () => {
    expect(toCustomerRow(customerRow())).toEqual({
      userId: ids.user,
      accountType: 'individual',
      maskedEmail: 'a•••@gmail.com',
      joinedAt: '2026-09-01T10:00:00Z',
      domainsHeld: 2,
      ordersPaid: 1,
      totalPaidKobo: 1_870_000,
      hasTotp: true,
      emailConfirmed: true,
      lastSignInAt: '2026-10-02T09:00:00Z',
      isAdmin: false,
    })
  })

  it('reads nulls as nothing rather than failing', () => {
    expect(
      toCustomerRow(
        customerRow({
          masked_email: null,
          domains_held: null,
          orders_paid: null,
          total_paid_kobo: null,
          has_totp: null,
          email_confirmed: null,
          is_admin: null,
        }),
      ),
    ).toMatchObject({
      maskedEmail: '—',
      domainsHeld: 0,
      ordersPaid: 0,
      totalPaidKobo: 0,
      hasTotp: false,
      emailConfirmed: false,
      isAdmin: false,
    })
  })
})

describe('parseCustomer', () => {
  it('reads the masked account, its counts and its allowance', () => {
    expect(parseCustomer(customerJson())).toMatchObject({
      userId: ids.user,
      maskedEmail: 'a•••@gmail.com',
      counts: { domains: 3, orders: 2, spentKobo: 2_010_250, refunds: 1 },
      allowance: { ordered: 2, max: 10, tier: 'standard' },
    })
  })

  it('keeps the account when the allowance cannot be read', () => {
    expect(parseCustomer(customerJson({ allowance: 'nope' }))?.allowance).toBeNull()
  })

  it('refuses an answer without an account id or counts', () => {
    expect(parseCustomer(customerJson({ userId: 'not-an-id' }))).toBeNull()
    expect(parseCustomer(customerJson({ counts: undefined }))).toBeNull()
  })
})

describe('parseFoundCustomers', () => {
  it('reads a search’s masked rows', () => {
    expect(
      parseFoundCustomers({
        ok: true,
        auditId: 1,
        rows: [
          {
            userId: ids.user,
            maskedEmail: 'e•••@example.com',
            joinedAt: '2026-10-01T00:00:00Z',
            domainsHeld: 1,
            ordersPaid: 2,
          },
        ],
      }),
    ).toEqual([
      {
        userId: ids.user,
        maskedEmail: 'e•••@example.com',
        joinedAt: '2026-10-01T00:00:00Z',
        domainsHeld: 1,
        ordersPaid: 2,
      },
    ])
  })

  it('reads no rows from an answer without a list, or a list it cannot read', () => {
    expect(parseFoundCustomers({ ok: true, auditId: 1 })).toEqual([])
    expect(parseFoundCustomers(null)).toEqual([])
    expect(parseFoundCustomers({ rows: [{ userId: 'x' }] })).toEqual([])
  })
})

describe('parseContact', () => {
  it('reads a fresh reveal’s contact', () => {
    expect(
      parseContact({
        ok: true,
        auditId: 9,
        contact: { email: 'a@b.ng', fullName: 'A B', phone: null, businessName: null },
      }),
    ).toEqual({ email: 'a@b.ng', fullName: 'A B', phone: null, businessName: null })
  })

  it('reads no contact from a replayed key, which carries none (D4)', () => {
    expect(parseContact({ ok: true, auditId: 9, replayed: true })).toBeNull()
    expect(parseContact({ ok: true, auditId: 9, contact: null })).toBeNull()
    expect(parseContact(null)).toBeNull()
    expect(parseContact({ contact: 'a@b.ng' })).toBeNull()
  })
})
