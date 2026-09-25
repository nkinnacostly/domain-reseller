import { describe, expect, it } from 'vitest'
import nextConfig from '../../../next.config'

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
