import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAttentionCounts } from '@/features/admin/queries/attention'
import { optionalReasonSchema, reasonSchema } from '@/features/admin/schemas/common'
import { createClient } from '@/lib/supabase/server'
import { sessionClient } from './fixtures'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const counts = {
  refunds: 2,
  jobs: '3',
  incidents: 0,
  alertsCritical: 1,
  alertsWarning: 0,
  drift: 0,
  stuckOrders: 0,
  pendingWithoutJob: 0,
  emailsFailed: 4,
  ledgerUnexplained: 0,
  presetDrafts: 1,
}

beforeEach(() => vi.clearAllMocks())

describe('getAttentionCounts', () => {
  it('asks SQL for one side, and reads every count as a whole number', async () => {
    const session = sessionClient({ rpc: { admin_attention_counts: { data: counts } } })
    vi.mocked(createClient).mockResolvedValue(session.client as never)

    const read = await getAttentionCounts('test')

    expect(session.rpc).toHaveBeenCalledWith('admin_attention_counts', { p_test_mode: true })
    expect(read).toMatchObject({ refunds: 2, jobs: 3, emailsFailed: 4, presetDrafts: 1 })
  })

  it('reads a missing or bad count as zero', async () => {
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({
        rpc: { admin_attention_counts: { data: { ...counts, drift: 'lots', jobs: -1 } } },
      }).client as never,
    )
    expect(await getAttentionCounts('live')).toMatchObject({ drift: 0, jobs: 0 })
  })

  it('leaves the badges off when SQL refuses, or answers something else', async () => {
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({
        rpc: { admin_attention_counts: { error: { message: 'admin:test_admin', code: '42501' } } },
      }).client as never,
    )
    expect(await getAttentionCounts('live')).toBeNull()
    vi.mocked(createClient).mockResolvedValue(
      sessionClient({ rpc: { admin_attention_counts: { data: 'nope' } } }).client as never,
    )
    expect(await getAttentionCounts('live')).toBeNull()
  })
})

describe('common schemas', () => {
  it('needs 10 to 500 characters of reason, trimmed', () => {
    expect(reasonSchema.safeParse('   too short ').success).toBe(false)
    expect(reasonSchema.parse('  checked the order  ')).toBe('checked the order')
    expect(reasonSchema.safeParse('x'.repeat(501)).success).toBe(false)
  })

  it('reads an empty optional reason as none', () => {
    expect(optionalReasonSchema.parse('   ')).toBeUndefined()
    expect(optionalReasonSchema.parse(undefined)).toBeUndefined()
    expect(optionalReasonSchema.parse(' looked ')).toBe('looked')
  })
})
