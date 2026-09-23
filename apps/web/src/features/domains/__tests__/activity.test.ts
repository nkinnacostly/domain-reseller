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

  it('falls back to readable words for anything new', () => {
    expect(describeEvent('something_new', {})).toBe('something new')
  })
})
