import { describe, expect, it } from 'vitest'
import { describeLengthIssue, lengthIssue } from '../lib/length'

describe('lengthIssue (FR-S9)', () => {
  it('has nothing to say when the extension has no known rule', () => {
    expect(lengthIssue('a', undefined)).toBeNull()
    expect(lengthIssue('a', { min: null, max: null })).toBeNull()
  })

  it('refuses a name one character under the minimum', () => {
    expect(lengthIssue('ab', { min: 3, max: 63 })).toEqual({ kind: 'too-short', min: 3, max: 63 })
  })

  it('accepts the minimum and the maximum exactly', () => {
    expect(lengthIssue('abc', { min: 3, max: 63 })).toBeNull()
    expect(lengthIssue('a'.repeat(63), { min: 3, max: 63 })).toBeNull()
  })

  it('refuses a name one character over the maximum', () => {
    expect(lengthIssue('a'.repeat(64), { min: 3, max: 63 })).toEqual({
      kind: 'too-long',
      min: 3,
      max: 63,
    })
  })

  it('applies a rule that has only one bound', () => {
    expect(lengthIssue('ab', { min: 3, max: null })?.kind).toBe('too-short')
    expect(lengthIssue('abcdef', { min: null, max: 5 })?.kind).toBe('too-long')
  })

  it('measures an international name by the xn-- form the supplier receives', () => {
    // café is 4 letters, but xn--caf-dma is 11.
    expect(lengthIssue('xn--caf-dma', { min: 1, max: 10 })?.kind).toBe('too-long')
  })
})

describe('describeLengthIssue', () => {
  it('gives the range when both ends are known', () => {
    expect(describeLengthIssue({ kind: 'too-short', min: 3, max: 63 }, 'ab', 'io')).toBe(
      'Too short for .io (3–63 characters)',
    )
  })

  it('gives the one end that is known', () => {
    expect(describeLengthIssue({ kind: 'too-short', min: 3, max: null }, 'ab', 'io')).toBe(
      'Too short for .io (at least 3 characters)',
    )
    expect(describeLengthIssue({ kind: 'too-long', min: null, max: 5 }, 'abcdef', 'ng')).toBe(
      'Too long for .ng (at most 5 characters)',
    )
  })

  it('says an international name is counted in its xn-- form', () => {
    expect(describeLengthIssue({ kind: 'too-long', min: 1, max: 10 }, 'xn--caf-dma', 'de')).toBe(
      'Too long for .de (1–10 characters, counted in its xn-- form)',
    )
  })
})
