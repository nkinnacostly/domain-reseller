import { describe, expect, it } from 'vitest'
import { clientAddress, forwardedAuthHeaders } from '../supabase/forwarded'

describe('clientAddress', () => {
  it('has none when the platform reported none', () => {
    expect(clientAddress(new Headers())).toBeNull()
  })

  it('refuses anything that is not an address, rather than pass it on', () => {
    expect(clientAddress(new Headers({ 'x-real-ip': 'evil, 1.2.3.4' }))).toBeNull()
    expect(clientAddress(new Headers({ 'x-forwarded-for': '<script>' }))).toBeNull()
  })

  it("prefers the platform's single address", () => {
    const source = new Headers({ 'x-real-ip': '102.89.1.2', 'x-forwarded-for': '10.0.0.1' })
    expect(clientAddress(source)).toBe('102.89.1.2')
  })

  it('takes the first hop of a forwarded chain', () => {
    const source = new Headers({ 'x-forwarded-for': '2001:db8::1, 10.0.0.1' })
    expect(clientAddress(source)).toBe('2001:db8::1')
  })
})

describe('forwardedAuthHeaders (FR-A5)', () => {
  it('sends nothing it was not given', () => {
    expect(forwardedAuthHeaders(new Headers())).toEqual({})
  })

  it("passes on the person's browser and address, so their session records them", () => {
    const source = new Headers({
      'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140.0',
      'x-forwarded-for': '102.89.1.2',
    })
    expect(forwardedAuthHeaders(source)).toEqual({
      'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140.0',
      'x-forwarded-for': '102.89.1.2',
    })
  })

  it('cuts an absurdly long user agent down', () => {
    const source = new Headers({ 'user-agent': 'x'.repeat(5000) })
    expect(forwardedAuthHeaders(source)['user-agent']).toHaveLength(512)
  })
})
