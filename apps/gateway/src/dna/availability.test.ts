import { describe, expect, it } from 'vitest'
import { classifyAvailability } from './availability'

/** Rows shaped exactly as production returned them on 22 Sept 2026. */
describe('classifyAvailability', () => {
  it('never reports an unrecognised refusal as available', () => {
    expect(classifyAvailability({ Status: 'notavailable', Reason: 'Something new' })).toBe(
      'restricted',
    )
    expect(classifyAvailability({ Status: 'notavailable', Reason: null })).toBe('restricted')
  })

  it('flags a registry premium, which the API cannot register', () => {
    expect(
      classifyAvailability({
        Status: 'notavailable',
        IsFee: true,
        Reason: 'Premium domain name. Please cont',
      }),
    ).toBe('premium')
  })

  it.each(['Domain exists', 'In use', 'in use'])('reads "%s" as registered', (Reason) => {
    expect(classifyAvailability({ Status: 'notavailable', IsFee: false, Reason })).toBe(
      'registered',
    )
  })

  it('treats a name the extension forbids as restricted', () => {
    expect(
      classifyAvailability({
        Status: 'notavailable',
        Reason: 'The domain name must contain at least 3 and no more than 63 characters.',
      }),
    ).toBe('restricted')
  })

  it('reads an open name as available', () => {
    expect(classifyAvailability({ Status: 'available', IsFee: false, Reason: null })).toBe(
      'available',
    )
  })
})
