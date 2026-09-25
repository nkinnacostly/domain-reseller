import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  HUMAN_PASS_COOKIE,
  HUMAN_PASS_SECONDS,
  isValidHumanPass,
  signHumanPass,
} from '../lib/human-pass'

const SECRET = 'sb_secret_test_only'
const ME = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'
const SOMEONE_ELSE = 'ffffffffffffffffffffffffffffffff'
const NOW = 1_790_000_000

describe('the search pass — refusals first (SEC-9)', () => {
  it('is worth nothing when missing or malformed', () => {
    for (const value of [undefined, '', 'yes', '123', `${NOW + 60}.short`, `x.${'a'.repeat(43)}`]) {
      expect(isValidHumanPass(value, SECRET, ME, NOW)).toBe(false)
    }
  })

  it('cannot be forged without the server secret', () => {
    expect(isValidHumanPass(signHumanPass('guessed-secret', ME, NOW), SECRET, ME, NOW)).toBe(false)
  })

  it('cannot be extended by editing its expiry', () => {
    const pass = signHumanPass(SECRET, ME, NOW)
    const [, mac] = pass.split('.')
    expect(isValidHumanPass(`${NOW + 60}.${mac}`, SECRET, ME, NOW)).toBe(false)
  })

  it('is worth nothing on another connection', () => {
    expect(isValidHumanPass(signHumanPass(SECRET, SOMEONE_ELSE, NOW), SECRET, ME, NOW)).toBe(false)
  })

  it('runs out after two hours', () => {
    const pass = signHumanPass(SECRET, ME, NOW)
    expect(isValidHumanPass(pass, SECRET, ME, NOW + HUMAN_PASS_SECONDS - 1)).toBe(true)
    expect(isValidHumanPass(pass, SECRET, ME, NOW + HUMAN_PASS_SECONDS)).toBe(false)
  })

  it('refuses an expiry further off than any pass we issue, even correctly signed', () => {
    // Signed with the real secret and the right address: only the expiry is wrong.
    const expires = NOW + HUMAN_PASS_SECONDS + 60
    const mac = createHmac('sha256', SECRET)
      .update(`search-pass:v1:${expires}:${ME}`)
      .digest('base64url')
    expect(isValidHumanPass(`${expires}.${mac}`, SECRET, ME, NOW)).toBe(false)
  })

  it('is not interchangeable with the address hash the same secret makes', () => {
    // clientKey() HMACs a bare address with this secret; a pass MAC names its purpose.
    const expires = NOW + 60
    const bare = createHmac('sha256', SECRET).update(`${expires}:${ME}`).digest('base64url')
    expect(isValidHumanPass(`${expires}.${bare}`, SECRET, ME, NOW)).toBe(false)
  })
})

describe('the search pass', () => {
  it('holds for this connection, for two hours, and names no address', () => {
    const pass = signHumanPass(SECRET, ME, NOW)
    expect(pass).toMatch(/^\d+\.[\w-]{43}$/)
    expect(pass.startsWith(`${NOW + HUMAN_PASS_SECONDS}.`)).toBe(true)
    expect(pass).not.toContain(ME)
    expect(isValidHumanPass(pass, SECRET, ME, NOW)).toBe(true)
  })

  it('lives in its own cookie, for two hours', () => {
    expect(HUMAN_PASS_COOKIE).toBe('dr_search_pass')
    expect(HUMAN_PASS_SECONDS).toBe(7_200)
  })
})
