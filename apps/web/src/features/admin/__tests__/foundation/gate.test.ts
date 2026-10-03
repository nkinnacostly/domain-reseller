import { describe, expect, it } from 'vitest'
import {
  ADMIN_NOT_FOUND_PATH,
  adminCsp,
  adminDecision,
  adminHeaders,
  adminNonce,
  isAdminPath,
  signedInDestination,
  toAdminStatus,
} from '../../lib/gate'

/** ADMIN-SPEC §2.3, D9: what the proxy does at /admin. */

const ORIGIN = 'https://www.mydomainshub.com'

describe('the admin gate', () => {
  it('knows the admin area and nothing that only looks like it', () => {
    expect(isAdminPath('/admin')).toBe(true)
    expect(isAdminPath('/admin/refunds/1')).toBe(true)
    expect(isAdminPath('/administrator')).toBe(false)
    expect(isAdminPath('/app/admin')).toBe(false)
  })

  it('reads admin_status, and treats anything else as a stranger', () => {
    for (const word of [
      'ok',
      'needs_code',
      'factor_mismatch',
      'weak_sign_in',
      'not_admin',
    ] as const) {
      expect(toAdminStatus(word)).toBe(word)
    }
    expect(toAdminStatus(null)).toBe('not_admin')
    expect(toAdminStatus('owner')).toBe('not_admin')
    expect(toAdminStatus(1)).toBe('not_admin')
  })

  it('hides /admin from strangers, asks for a code when it is stale, and lets the rest through to the layout', () => {
    expect(adminDecision('not_admin')).toEqual({ kind: 'not_found' })
    expect(adminDecision('needs_code')).toEqual({ kind: 'verify' })
    expect(adminDecision('ok')).toEqual({ kind: 'continue' })
    expect(adminDecision('factor_mismatch')).toEqual({ kind: 'continue' })
    expect(adminDecision('weak_sign_in')).toEqual({ kind: 'continue' })
    expect(ADMIN_NOT_FOUND_PATH).toBe('/__not-found')
  })

  it('sends a signed-in admin from /sign-in?next=/admin to /admin, everyone else to the panel', () => {
    expect(signedInDestination('/admin', ORIGIN)).toBe('/admin')
    expect(signedInDestination('/admin/refunds?status=held', ORIGIN)).toBe(
      '/admin/refunds?status=held',
    )
    expect(signedInDestination('/app/orders', ORIGIN)).toBe('/app/domains')
    expect(signedInDestination(null, ORIGIN)).toBe('/app/domains')
    expect(signedInDestination('https://evil.example/admin', ORIGIN)).toBe('/app/domains')
    expect(signedInDestination('//evil.example/admin', ORIGIN)).toBe('/app/domains')
  })
})

describe('the admin Content Security Policy', () => {
  it('allows scripts only with this response’s nonce — never unsafe-inline', () => {
    const nonce = adminNonce()
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(adminNonce()).not.toBe(nonce)
    const policy = new Map(
      adminCsp(nonce, { supabaseHost: 'abc.supabase.co', development: false })
        .split('; ')
        .map((directive) => {
          const [name = '', ...sources] = directive.split(' ')
          return [name, sources.join(' ')]
        }),
    )
    expect(policy.get('script-src')).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic'`)
    expect(policy.get('script-src')).not.toContain('unsafe-inline')
    expect(policy.get('object-src')).toBe("'none'")
    expect(policy.get('base-uri')).toBe("'none'")
    expect(policy.get('frame-ancestors')).toBe("'none'")
    expect(policy.get('frame-src')).toBe("'none'")
    expect(policy.get('connect-src')).toBe("'self' https://abc.supabase.co wss://abc.supabase.co")
  })

  it('adds unsafe-eval only for local development', () => {
    expect(adminCsp('n', { supabaseHost: 'x', development: true })).toContain("'unsafe-eval'")
  })

  it('marks every admin answer private and unindexed', () => {
    expect(adminHeaders('policy')).toEqual({
      'Content-Security-Policy': 'policy',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'private, no-store',
    })
  })
})
