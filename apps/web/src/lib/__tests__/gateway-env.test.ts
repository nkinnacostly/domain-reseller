import { afterEach, describe, expect, it, vi } from 'vitest'

/** env.ts reads process.env once, at import — so each case imports it fresh. */
async function gatewayEnv(vars: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value)
  const { requireGatewayEnv } = await import('../env')
  return requireGatewayEnv
}

afterEach(() => vi.unstubAllEnvs())

describe('requireGatewayEnv', () => {
  it('says exactly what is missing when the shared secret is not set', async () => {
    const require = await gatewayEnv({
      GATEWAY_URL: 'http://gateway.test',
      GATEWAY_SHARED_SECRET: undefined,
    })
    expect(() => require()).toThrow(/set GATEWAY_SHARED_SECRET/)
  })

  it('treats an empty shared secret as missing', async () => {
    const require = await gatewayEnv({
      GATEWAY_URL: 'http://gateway.test',
      GATEWAY_SHARED_SECRET: '',
    })
    expect(() => require()).toThrow(/GATEWAY_SHARED_SECRET/)
  })

  it('hands back the gateway address and secret when both are set', async () => {
    const require = await gatewayEnv({
      GATEWAY_URL: 'http://gateway.test',
      GATEWAY_SHARED_SECRET: 'test-secret-value-16',
    })
    expect(require()).toEqual({
      url: 'http://gateway.test',
      sharedSecret: 'test-secret-value-16',
    })
  })
})

describe('requireAdminGatewayEnv (ADMIN-SPEC §4.1)', () => {
  async function adminEnv(value: string | undefined) {
    vi.resetModules()
    vi.stubEnv('GATEWAY_ADMIN_SECRET', value)
    const { requireAdminGatewayEnv } = await import('../env')
    return requireAdminGatewayEnv
  }

  it('says the admin reads are off without their secret', async () => {
    expect(await adminEnv(undefined).then((require) => () => require())).toThrow(
      /GATEWAY_ADMIN_SECRET/,
    )
  })

  it('hands back the admin secret when set', async () => {
    const require = await adminEnv('f'.repeat(64))
    expect(require()).toEqual({ adminSecret: 'f'.repeat(64) })
  })
})
