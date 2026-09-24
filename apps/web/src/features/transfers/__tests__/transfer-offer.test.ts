import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient } from '@/lib/supabase/public'

vi.mock('@/lib/supabase/public', () => ({ createPublicClient: vi.fn() }))

const { takesTransfersFor } = await import('../queries/transfer-offer')

let answer: { data: unknown; error: { message: string } | null }
const asked: string[] = []

beforeEach(() => {
  asked.length = 0
  answer = { data: { is_transferable: true, transfer_usd: 10.61 }, error: null }
  const node = {
    select: () => node,
    eq: (_column: string, value: string) => {
      asked.push(value)
      return node
    },
    maybeSingle: async () => answer,
  }
  vi.mocked(createPublicClient).mockReturnValue({ from: () => node } as never)
})

describe('takesTransfersFor', () => {
  it('reads the extension’s flag and price from the catalogue', async () => {
    await expect(takesTransfersFor('com')).resolves.toBe(true)
    expect(asked).toEqual(['com'])
  })

  it('says no for an extension not cleared, not listed, or not readable', async () => {
    answer = { data: { is_transferable: null, transfer_usd: 10.61 }, error: null }
    await expect(takesTransfersFor('com')).resolves.toBe(false)
    answer = { data: null, error: null }
    await expect(takesTransfersFor('nope')).resolves.toBe(false)
    answer = { data: null, error: { message: 'network' } }
    await expect(takesTransfersFor('com')).resolves.toBe(false)
  })
})
