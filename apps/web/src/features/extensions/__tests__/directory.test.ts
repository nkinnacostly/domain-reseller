import { describe, expect, it } from 'vitest'
import { buildDirectory } from '../lib/directory'

describe('buildDirectory', () => {
  const directory = buildDirectory([
    { tld: 'org', isCountryCode: false },
    { tld: 'com', isCountryCode: false },
    { tld: 'africa', isCountryCode: false },
    { tld: 'co', isCountryCode: true },
    { tld: 'com.ng', isCountryCode: true },
    { tld: 'com', isCountryCode: false },
  ])

  it('leads with the extensions people here know, where we sell them', () => {
    expect(directory.popular).toEqual(['com', 'org', 'africa', 'co'])
  })

  it('files generic and country extensions A–Z by first letter, each once', () => {
    expect(directory.generic).toEqual([
      { letter: 'A', tlds: ['africa'] },
      { letter: 'C', tlds: ['com'] },
      { letter: 'O', tlds: ['org'] },
    ])
    expect(directory.country).toEqual([{ letter: 'C', tlds: ['co', 'com.ng'] }])
    expect(directory.total).toBe(5)
  })

  it('files an extension that starts with a number or punycode under #', () => {
    const odd = buildDirectory([{ tld: '1xyz', isCountryCode: false }])
    expect(odd.generic).toEqual([{ letter: '#', tlds: ['1xyz'] }])
  })
})
