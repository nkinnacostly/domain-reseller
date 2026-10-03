import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_TABS,
  customerFilter,
  customersHref,
  customerTabHref,
  customerTabs,
  isFiltered,
  parseCustomerListParams,
  tabPage,
} from '@/features/admin/lib/customers-params'

/**
 * The customers list's URL (ADMIN-SPEC §5.2 B8): sorts SQL allows, three
 * filters, paging — and nothing that names a person (N13).
 */

const ID = '2a2b2c2d-3e3f-4a4b-8c5d-6e6f7a7b8c8d'

describe('parseCustomerListParams', () => {
  it('defaults to the newest accounts first, 25 to a page, unfiltered', () => {
    expect(parseCustomerListParams({})).toEqual({
      sort: 'joined',
      dir: 'desc',
      page: 1,
      per: 25,
      status: [],
      from: null,
      to: null,
      holders: null,
      twofa: null,
      type: null,
    })
  })

  it('takes every sort SQL allows, and the three filters', () => {
    for (const sort of ['joined', 'domains', 'orders', 'paid', 'last_sign_in']) {
      expect(parseCustomerListParams({ sort }).sort).toBe(sort)
    }
    expect(
      parseCustomerListParams(
        new URLSearchParams('sort=paid&dir=asc&page=3&per=50&holders=no&twofa=on&type=business'),
      ),
    ).toMatchObject({
      sort: 'paid',
      dir: 'asc',
      page: 3,
      per: 50,
      holders: 'no',
      twofa: 'on',
      type: 'business',
    })
  })

  it('falls back to the unfiltered list for anything it does not know', () => {
    const params = parseCustomerListParams({
      sort: 'email',
      dir: 'sideways',
      page: '-2',
      per: '1000',
      holders: 'maybe',
      twofa: ['sms', 'on'],
      type: 'robot',
      q: 'someone@example.com',
    })
    expect(params).toMatchObject({
      sort: 'joined',
      dir: 'desc',
      page: 1,
      per: 25,
      holders: null,
      twofa: null,
      type: null,
    })
    // There is no search parameter at all: an email never reaches the list's URL.
    expect(Object.values(params).flat()).not.toContain('someone@example.com')
  })
})

describe('customersHref', () => {
  const base = parseCustomerListParams({ sort: 'domains', page: '4', holders: 'yes' })

  it('keeps defaults out of the address', () => {
    expect(customersHref(parseCustomerListParams({}))).toBe('/admin/customers')
  })

  it('keeps the page for a page link, and goes back to page 1 for any other change', () => {
    expect(customersHref(base, { page: 5 })).toBe(
      '/admin/customers?sort=domains&page=5&holders=yes',
    )
    expect(customersHref(base, { twofa: 'off' })).toBe(
      '/admin/customers?sort=domains&holders=yes&twofa=off',
    )
    expect(customersHref(base, { sort: 'joined', dir: 'asc' })).toBe(
      '/admin/customers?dir=asc&holders=yes',
    )
    expect(customersHref(base, { holders: null })).toBe('/admin/customers?sort=domains')
  })

  it('carries the current page when nothing changes', () => {
    expect(customersHref(base)).toBe('/admin/customers?sort=domains&page=4&holders=yes')
  })
})

describe('customerFilter and isFiltered', () => {
  it('sends SQL only the filters chosen, in its own keys', () => {
    expect(customerFilter(parseCustomerListParams({}))).toEqual({})
    expect(
      customerFilter(parseCustomerListParams({ holders: 'no', twofa: 'on', type: 'individual' })),
    ).toEqual({ holders: false, hasTotp: true, accountType: 'individual' })
    expect(customerFilter(parseCustomerListParams({ holders: 'yes', twofa: 'off' }))).toEqual({
      holders: true,
      hasTotp: false,
    })
  })

  it('says a list is filtered only when a filter is chosen', () => {
    expect(isFiltered(parseCustomerListParams({ sort: 'paid', page: '2' }))).toBe(false)
    expect(isFiltered(parseCustomerListParams({ type: 'business' }))).toBe(true)
    expect(isFiltered(parseCustomerListParams({ twofa: 'off' }))).toBe(true)
    expect(isFiltered(parseCustomerListParams({ holders: 'yes' }))).toBe(true)
  })
})

describe('one customer’s tabs', () => {
  it('builds each tab from the checked id, the overview exact', () => {
    expect(customerTabHref(ID, 'overview')).toBe(`/admin/customers/${ID}`)
    expect(customerTabHref(ID.toUpperCase(), 'orders')).toBe(`/admin/customers/${ID}/orders`)
    expect(customerTabs(ID, { orders: 2 })).toEqual([
      { href: `/admin/customers/${ID}`, label: 'Overview', exact: true },
      { href: `/admin/customers/${ID}/domains`, label: 'Domains' },
      { href: `/admin/customers/${ID}/orders`, label: 'Orders', count: 2 },
      { href: `/admin/customers/${ID}/certificates`, label: 'Certificates' },
      { href: `/admin/customers/${ID}/emails`, label: 'Emails' },
    ])
    expect(customerTabs(ID).map((tab) => tab.label)).toHaveLength(CUSTOMER_TABS.length)
  })

  it('never builds a tab from something that is not an id', () => {
    for (const tab of CUSTOMER_TABS) {
      expect(customerTabHref('someone@example.com', tab)).toBe('/admin/customers')
    }
  })

  it('reads a tab’s page, and anything odd is page 1', () => {
    expect(tabPage({ page: '3' })).toBe(3)
    expect(tabPage(new URLSearchParams('page=7'))).toBe(7)
    for (const page of [undefined, '0', 'x', '-1', '123456']) {
      expect(tabPage({ page })).toBe(1)
    }
  })
})
