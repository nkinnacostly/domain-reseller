import { describe, expect, it } from 'vitest'
import nextConfig, { NOT_ADMIN } from '../../../next.config'

async function policy(): Promise<Map<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? []
  const csp = rules[0]?.headers.find((header) => header.key === 'Content-Security-Policy')?.value
  return new Map(
    (csp ?? '').split('; ').map((directive) => {
      const [name = '', ...sources] = directive.split(' ')
      return [name, sources.join(' ')]
    }),
  )
}

describe('Content Security Policy (SEC-15) and Turnstile (SEC-9)', () => {
  it('lets Cloudflare Turnstile’s script run and its challenge frame load', async () => {
    const csp = await policy()
    expect(csp.get('script-src')).toContain('https://challenges.cloudflare.com')
    expect(csp.get('frame-src')).toBe('https://challenges.cloudflare.com')
  })

  it('opens nothing else to Cloudflare, and still refuses to be framed', async () => {
    const csp = await policy()
    for (const directive of ['connect-src', 'img-src', 'style-src', 'form-action']) {
      expect(csp.get(directive), directive).not.toContain('cloudflare')
    }
    expect(csp.get('default-src')).toBe("'self'")
    expect(csp.get('frame-ancestors')).toBe("'none'")
    expect(csp.get('object-src')).toBe("'none'")
  })
})

describe('the admin area keeps its own policy (ADMIN-SPEC §2.3)', () => {
  const notAdmin = new RegExp(`^/${NOT_ADMIN}$`)

  it('leaves /admin out of the site-wide policy, and nothing else', async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const withCsp = rules.filter((rule) =>
      rule.headers.some((header) => header.key === 'Content-Security-Policy'),
    )
    expect(withCsp.map((rule) => rule.source)).toEqual([`/:path(${NOT_ADMIN})`])
    for (const path of ['/', '/pricing', '/app/domains', '/administrator', '/legal/admin']) {
      expect(notAdmin.test(path), path).toBe(true)
    }
    for (const path of ['/admin', '/admin/', '/admin/refunds/1']) {
      expect(notAdmin.test(path), path).toBe(false)
    }
  })

  it('still sends the other security headers everywhere', async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const everywhere = rules.find((rule) => rule.source === '/:path*')
    expect(everywhere?.headers.map((header) => header.key)).toEqual(
      expect.arrayContaining([
        'X-Content-Type-Options',
        'X-Frame-Options',
        'Strict-Transport-Security',
      ]),
    )
  })
})
