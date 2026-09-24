import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))

const { logger } = await import('@/lib/logger')
const { noteSignIn, queueAccountNotice } = await import('../queries/notices')

function service(result: { error: { message: string } | null } = { error: null }) {
  const rpc = vi.fn(async () => ({ data: null, ...result }))
  vi.mocked(createServiceClient).mockReturnValue({ rpc } as never)
  return rpc
}

beforeEach(() => vi.clearAllMocks())

describe('security notices from the web (SEC-4)', () => {
  it('records a sign-in as the device people would recognise, not the raw user agent', async () => {
    const rpc = service()
    await noteSignIn(
      'user-1',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    )
    expect(rpc).toHaveBeenCalledWith('note_sign_in', {
      p_user_id: 'user-1',
      p_device: 'Safari on iOS',
    })
  })

  it('queues a password or two-factor notice', async () => {
    const rpc = service()
    await queueAccountNotice('user-1', 'two_factor_off')
    expect(rpc).toHaveBeenCalledWith('queue_account_email', {
      p_user_id: 'user-1',
      p_kind: 'two_factor_off',
    })
  })

  it('never turns a finished sign-in or change into an error — it logs instead', async () => {
    service({ error: { message: 'permission denied' } })
    await expect(noteSignIn('user-1', null)).resolves.toBeUndefined()
    await expect(queueAccountNotice('user-1', 'password_changed')).resolves.toBeUndefined()
    vi.mocked(createServiceClient).mockImplementation(() => {
      throw new Error('SUPABASE_SECRET_KEY is not set')
    })
    await expect(noteSignIn('user-1', null)).resolves.toBeUndefined()
    await expect(queueAccountNotice('user-1', 'password_changed')).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledTimes(4)
  })
})
