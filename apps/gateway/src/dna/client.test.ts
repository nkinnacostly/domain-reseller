import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getDnaClient, getDnaWriteClient } from './client'

/**
 * SEC-14 guard. This test exists so that disabling supplier telemetry cannot be
 * removed by accident — it is an NDPA compliance control, not a preference.
 */
describe('DomainNameAPI client construction', () => {
  const source = readFileSync(fileURLToPath(new URL('./client.ts', import.meta.url)), 'utf8')
  // Code only: the comments mention the option too.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('disables the supplier SDK telemetry on every client', () => {
    const constructed = code.match(/new DomainNameApi\(/g) ?? []
    const disabled = code.match(/telemetry:\s*false/g) ?? []
    expect(constructed.length).toBeGreaterThan(0)
    expect(disabled.length).toBe(constructed.length)
  })

  it('never enables telemetry anywhere in the file', () => {
    expect(source).not.toMatch(/telemetry:\s*true/)
  })

  it('selects the OTE sandbox unless DNA_ENV is production', () => {
    expect(source).toMatch(/testMode:\s*env\.DNA_ENV\s*!==\s*'production'/)
  })

  it('writes to the sandbox unless the target is production', () => {
    expect(source).toMatch(/testMode:\s*target\s*!==\s*'production'/)
  })
})

describe('transport', () => {
  it('replaces the SDK’s HTTP layer, which does not verify certificates', () => {
    const client = getDnaClient()
    expect(client.getActiveTransport()).toBe('REST')
    expect(client.client._axios?.name).toBe('send')
  })

  it('refuses to write anywhere without the key for it', () => {
    // The test environment has no sandbox key.
    expect(() => getDnaWriteClient('ote')).toThrow(/No supplier key/)
  })
})
