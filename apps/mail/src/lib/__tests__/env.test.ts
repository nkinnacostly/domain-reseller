import { afterEach, describe, expect, it, vi } from 'vitest'

/** Optional services are asserted where they are used, with the setting's name, never its value. */

async function freshEnv() {
  vi.resetModules()
  return import('../env')
}

afterEach(() => vi.unstubAllEnvs())

describe('requireApiKeyPepper (MR7)', () => {
  it('gives the pepper, or refuses by name when it is missing', async () => {
    expect((await freshEnv()).requireApiKeyPepper()).toBe(
      'test-pepper-of-at-least-thirty-two-characters',
    )
    vi.stubEnv('MAIL_API_KEY_PEPPER', '')
    expect((await freshEnv()).requireApiKeyPepper).toThrow('set MAIL_API_KEY_PEPPER')
  })
})

describe('requireSesManagerEnv (§4.3)', () => {
  it('needs both halves of the manager key, and defaults to eu-west-2', async () => {
    vi.stubEnv('MAIL_SES_MANAGER_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE')
    expect((await freshEnv()).requireSesManagerEnv).toThrow('MAIL_SES_MANAGER_SECRET_ACCESS_KEY')
    vi.stubEnv('MAIL_SES_MANAGER_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY')
    const { requireSesManagerEnv } = await freshEnv()
    expect(requireSesManagerEnv()).toEqual({
      region: 'eu-west-2',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    })
  })
})
