import { describe, expect, it } from 'vitest'
import { NAME_IDEA_WORDS } from './words'

describe('NAME_IDEA_WORDS', () => {
  it('holds each word once, lower-case ASCII, as a search for it would arrive', () => {
    expect(NAME_IDEA_WORDS.length).toBeGreaterThan(200)
    expect(new Set(NAME_IDEA_WORDS).size).toBe(NAME_IDEA_WORDS.length)
    for (const word of NAME_IDEA_WORDS) expect(word, word).toMatch(/^[a-z0-9]{2,20}$/)
  })
})
