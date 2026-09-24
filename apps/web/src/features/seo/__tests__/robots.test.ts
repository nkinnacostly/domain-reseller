import { describe, expect, it } from 'vitest'
import { AI_CRAWLERS, robotsRules, USER_AGENTS_FOR_PEOPLE } from '../lib/robots'

const SITE = 'https://www.mydomainshub.com'
const rules = robotsRules(SITE)
const groups = Array.isArray(rules.rules) ? rules.rules : [rules.rules]
const group = (agent: string) =>
  groups.find((rule) => [rule.userAgent].flat().includes(agent)) ?? null
const list = (value: string | string[] | undefined) => [value ?? []].flat()

describe('robots.txt', () => {
  it('points at the sitemap', () => {
    expect(rules.sitemap).toBe(`${SITE}/sitemap.xml`)
  })

  it('keeps every crawler out of the panel, the API and auth callbacks', () => {
    for (const rule of groups) {
      expect(list(rule.disallow)).toEqual(expect.arrayContaining(['/app/', '/api/', '/auth/']))
    }
  })

  it('welcomes the AI search and training crawlers by name, with the same rules as everyone', () => {
    for (const agent of [
      'OAI-SearchBot',
      'GPTBot',
      'Claude-SearchBot',
      'ClaudeBot',
      'PerplexityBot',
      'Google-Extended',
      'bingbot',
    ]) {
      expect(AI_CRAWLERS).toContain(agent)
    }
    const ai = group('GPTBot')
    const everyone = group('*')
    expect(ai?.allow).toEqual(everyone?.allow)
    expect(ai?.disallow).toEqual(everyone?.disallow)
    expect(list(ai?.allow)).toContain('/')
  })

  it('keeps crawlers off live lookups, which spend supplier capacity, but opens the bulk search page', () => {
    const crawl = group('*')
    expect(list(crawl?.disallow)).toEqual(
      expect.arrayContaining(['/search', '/transfer?', '/whois?', '/cart']),
    )
    expect(list(crawl?.allow)).toContain('/search/bulk$')
  })

  it('lets an assistant acting for a person run a search', () => {
    const forPeople = group('ChatGPT-User')
    expect(USER_AGENTS_FOR_PEOPLE).toContain('Claude-User')
    expect(list(forPeople?.disallow)).not.toContain('/search')
    expect(list(forPeople?.disallow)).toContain('/app/')
  })

  it('names each crawler in one group only', () => {
    const named = groups.flatMap((rule) => [rule.userAgent].flat())
    expect(new Set(named).size).toBe(named.length)
  })
})
