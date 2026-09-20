import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * SEC-14 guard. This test exists so that disabling supplier telemetry cannot be
 * removed by accident — it is an NDPA compliance control, not a preference.
 */
describe('DomainNameAPI client construction', () => {
  const source = readFileSync(fileURLToPath(new URL('./client.ts', import.meta.url)), 'utf8')

  it('disables the supplier SDK telemetry', () => {
    expect(source).toMatch(/telemetry:\s*false/)
  })

  it('never enables telemetry anywhere in the file', () => {
    expect(source).not.toMatch(/telemetry:\s*true/)
  })

  it('selects the OTE sandbox unless DNA_ENV is production', () => {
    expect(source).toMatch(/testMode:\s*env\.DNA_ENV\s*!==\s*'production'/)
  })
})
