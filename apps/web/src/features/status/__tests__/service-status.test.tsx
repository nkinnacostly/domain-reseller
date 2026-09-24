import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }))
vi.mock('@/lib/supabase/public', () => ({ createPublicClient: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

const { connection } = await import('next/server')
const { createPublicClient } = await import('@/lib/supabase/public')
const { logger } = await import('@/lib/logger')
const { getPublicStatus } = await import('../queries/status')
const { ServiceStatus, ServiceStatusSkeleton } = await import('../components/service-status')

function answer(result: { data: unknown; error: { message: string } | null } | Error) {
  const rpc = vi.fn(async () => {
    if (result instanceof Error) throw result
    return result
  })
  vi.mocked(createPublicClient).mockReturnValue({ rpc } as never)
  return rpc
}

const NOW = '2026-09-24T12:00:00+00:00'
const HEALTHY = {
  checked_at: NOW,
  gateway_seen_at: '2026-09-24T11:56:00+00:00',
  registry_checked_at: '2026-09-24T11:20:00+00:00',
  orders_delayed: false,
}

beforeEach(() => vi.clearAllMocks())

describe('getPublicStatus', () => {
  it('reads public_status() live, never from a cache', async () => {
    const rpc = answer({ data: HEALTHY, error: null })
    expect(await getPublicStatus()).toMatchObject({ ordersDelayed: false })
    expect(connection).toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('public_status')
  })

  it('is null, and logged, when the database refuses', async () => {
    answer({ data: null, error: { message: 'permission denied' } })
    expect(await getPublicStatus()).toBeNull()
    expect(logger.error).toHaveBeenCalled()
  })

  it('is null when the connection fails', async () => {
    answer(new Error('fetch failed'))
    expect(await getPublicStatus()).toBeNull()
  })

  it('is null when the answer is not the expected shape', async () => {
    answer({ data: { status: 'ok' }, error: null })
    expect(await getPublicStatus()).toBeNull()
    expect(logger.error).toHaveBeenCalledWith('public status had an unexpected shape')
  })
})

describe('ServiceStatus', () => {
  it('says everything is running when every line is', async () => {
    answer({ data: HEALTHY, error: null })
    render(await ServiceStatus())

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Everything is running normally',
    )
    expect(screen.getByText('Checked at 13:00 on 24 September 2026, Lagos time.')).toBeVisible()
    const lines = within(screen.getByRole('list', { name: 'Services' })).getAllByRole('listitem')
    expect(lines).toHaveLength(3)
    for (const item of lines) expect(item).toHaveTextContent('Operational')
    expect(screen.getByRole('link', { name: /Check again/ })).toHaveAttribute('href', '/status')
  })

  it('names what is delayed, in words and not colour alone', async () => {
    answer({ data: { ...HEALTHY, gateway_seen_at: null, orders_delayed: true }, error: null })
    render(await ServiceStatus())

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Some things are delayed')
    const provisioning = screen
      .getAllByRole('listitem')
      .find((item) => item.textContent?.includes('Registrations, renewals'))
    expect(provisioning).toHaveAttribute('data-state', 'delayed')
    expect(provisioning).toHaveTextContent('Delayed')
    expect(provisioning).toHaveTextContent(
      'paid orders wait in a queue and are processed when it returns',
    )
  })

  it('says it cannot tell, rather than claiming anything, when the status cannot be read', async () => {
    answer({ data: null, error: { message: 'down' } })
    render(await ServiceStatus())

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      "We couldn't read the service status",
    )
    expect(screen.queryByText(/Operational|Delayed/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Check again/ })).toBeInTheDocument()
  })

  it('has a skeleton while it reads', () => {
    render(<ServiceStatusSkeleton />)
    expect(screen.getByRole('status', { name: 'Checking the service status' })).toBeVisible()
  })
})
