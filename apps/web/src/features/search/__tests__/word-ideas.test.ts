import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient } from '@/lib/supabase/public'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
vi.mock('@/lib/supabase/public', () => ({ createPublicClient: vi.fn() }))

const { getWordIdeas } = await import('../queries/word-ideas')

function table(answer: { data: unknown; error: unknown }) {
  const asked: unknown[][] = []
  vi.mocked(createPublicClient).mockReturnValue({
    from: (name: string) => {
      asked.push(['from', name])
      const query = {
        select: (columns: string) => {
          asked.push(['select', columns])
          return query
        },
        eq: (column: string, value: string) => {
          asked.push(['eq', column, value])
          return query
        },
        maybeSingle: async () => answer,
      }
      return query
    },
  } as never)
  return asked
}

beforeEach(() => vi.resetAllMocks())

describe('getWordIdeas (feature 2)', () => {
  it('reads a curated word’s ideas, keeping only labels a registry takes, never the word itself', async () => {
    const asked = table({
      data: {
        ideas: [
          { label: 'farmhub', why: 'x' },
          { label: 'farm' },
          { label: 'Bad Label' },
          ...Array.from({ length: 12 }, (_, i) => ({ label: `agro${i}` })),
        ],
      },
      error: null,
    })
    const ideas = await getWordIdeas('farm')
    expect(asked).toEqual([
      ['from', 'name_idea_words'],
      ['select', 'ideas'],
      ['eq', 'word', 'farm'],
    ])
    expect(ideas[0]).toBe('farmhub')
    expect(ideas).not.toContain('farm')
    expect(ideas).toHaveLength(8)
  })

  it('asks nothing for a search that cannot be a curated word', async () => {
    const asked = table({ data: null, error: null })
    expect(await getWordIdeas('café')).toEqual([])
    expect(await getWordIdeas('x')).toEqual([])
    expect(asked).toEqual([])
  })

  it('answers no ideas for a word without any, a malformed row, or a failed read', async () => {
    table({ data: null, error: null })
    expect(await getWordIdeas('bakery')).toEqual([])
    table({ data: { ideas: 'not a list' }, error: null })
    expect(await getWordIdeas('bakery')).toEqual([])
    table({ data: null, error: { message: 'relation does not exist' } })
    expect(await getWordIdeas('bakery')).toEqual([])
  })
})
