import { describe, expect, it } from 'vitest'
import { describeEvent } from '../lib/activity'

describe('describeEvent', () => {
  it('names a sandbox registration for what it is', () => {
    expect(describeEvent('registered', { sandbox: true })).toBe(
      'Registered in the registrar’s test system',
    )
    expect(describeEvent('registered', { sandbox: false })).toBe('Registered')
  })

  it('explains a failure in our words, never the supplier’s (N10)', () => {
    expect(describeEvent('registration_failed', { code: 'DOMAIN_TAKEN' })).toBe(
      'Registration failed: Someone else registered this name before we could.',
    )
  })

  it('shows nameservers before and after a change (FR-N5)', () => {
    expect(describeEvent('nameservers_requested', { after: ['a.test', 'b.test'] })).toBe(
      'Nameserver change requested: a.test, b.test',
    )
    expect(describeEvent('nameservers_applied', { nameservers: ['a.test', 'b.test'] })).toBe(
      'Nameservers applied at the registry: a.test, b.test',
    )
    expect(describeEvent('nameservers_rejected', { requested: ['a.test'] })).toBe(
      'Nameservers refused by the registry: a.test',
    )
  })

  it('says when the registry changed something (§13.5)', () => {
    expect(
      describeEvent('expiry_updated_from_registry', { after: '2027-09-23T08:44:10.000Z' }),
    ).toBe('Expiry date updated from the registry: 23 September 2027')
    expect(describeEvent('nameservers_synced', { after: ['a.test', 'b.test'] })).toBe(
      'Nameservers updated from the registry: a.test, b.test',
    )
  })

  it('falls back to readable words for anything new', () => {
    expect(describeEvent('something_new', {})).toBe('something new')
  })

  it('names the order that paid for it, and still reads cleanly without one', () => {
    expect(describeEvent('order_paid', { order_number: 'DR-1042' })).toBe(
      'Paid for in order DR-1042',
    )
    expect(describeEvent('order_paid', {})).toBe('Paid for in order')
  })

  it('says a delay is the registry’s, not a failure', () => {
    expect(describeEvent('registration_delayed', {})).toBe(
      'Registration delayed — waiting on the registry',
    )
    expect(describeEvent('nameservers_delayed', {})).toBe(
      'Nameserver change delayed — waiting on the registry',
    )
    expect(describeEvent('nameservers_not_applied', {})).toBe('Nameserver change not applied')
  })

  it('explains an unknown failure code in plain words too', () => {
    expect(describeEvent('registration_failed', {})).toBe(
      'Registration failed: The registry could not complete it.',
    )
  })

  it('leaves the list empty rather than printing a malformed payload', () => {
    expect(describeEvent('nameservers_requested', { after: 'ns1.oops.test' })).toBe(
      'Nameserver change requested: ',
    )
  })

  it('still records an expiry change when the registry sent no date', () => {
    expect(describeEvent('expiry_updated_from_registry', {})).toBe(
      'Expiry date updated from the registry',
    )
  })

  it('names the period and the order that paid for a renewal', () => {
    expect(describeEvent('renewal_paid', { years: 2, order_number: 'DR-1043' })).toBe(
      'Renewal for 2 years paid for in order DR-1043',
    )
    expect(describeEvent('renewal_paid', { years: 1, order_number: 'DR-1044' })).toBe(
      'Renewal for 1 year paid for in order DR-1044',
    )
  })

  it('says when a renewed domain now expires, as a Lagos date', () => {
    expect(describeEvent('renewed', { years: 1, to: '2028-09-23T08:44:10.000Z' })).toBe(
      'Renewed for 1 year — now expires 23 September 2028',
    )
  })

  it('names a sandbox renewal for what it is', () => {
    expect(
      describeEvent('renewed', { years: 3, to: '2029-09-23T08:44:10.000Z', sandbox: true }),
    ).toBe('Renewed for 3 years in the registrar’s test system — now expires 23 September 2029')
    expect(describeEvent('renewed', { years: 2, sandbox: true })).toBe(
      'Renewed for 2 years in the registrar’s test system',
    )
  })

  it('still records a renewal when the registry sent no new date', () => {
    expect(describeEvent('renewed', { years: 2 })).toBe('Renewed for 2 years')
  })

  it.each([undefined, 0, -1, 1.5, 'two', null])(
    'says "a period" rather than printing a malformed number of years: %j',
    (years) => {
      expect(describeEvent('renewed', { years })).toBe('Renewed for a period')
      expect(describeEvent('renewal_paid', { years, order_number: 'DR-1' })).toBe(
        'Renewal for a period paid for in order DR-1',
      )
    },
  )

  it('explains a failed renewal in our words, never the supplier’s (N10)', () => {
    expect(describeEvent('renewal_failed', { code: 'NOT_RENEWABLE' })).toBe(
      'Renewal failed: This domain is not one this account can renew.',
    )
    expect(describeEvent('renewal_failed', { code: 'DOMAIN_NOT_FOUND' })).toBe(
      'Renewal failed: The registry does not list this domain in our account.',
    )
    expect(describeEvent('renewal_failed', {})).toBe(
      'Renewal failed: The registry could not complete it.',
    )
  })

  it('says a renewal delay is the registry’s, not a failure', () => {
    expect(describeEvent('renewal_delayed', {})).toBe('Renewal delayed — waiting on the registry')
  })

  it('records the customer’s own choices in their words', () => {
    expect(describeEvent('auto_renew_on', {})).toBe('Auto-renew turned on')
    expect(describeEvent('auto_renew_off', {})).toBe('Auto-renew turned off')
    expect(describeEvent('demo_created', {})).toBe('Added as a demo domain')
  })
})
