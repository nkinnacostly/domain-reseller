import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importSuppressions } from '../actions/suppressions'
import { ImportSuppressions } from '../components/import-suppressions'

/** "Import a list" (migration 68): read in the browser, sent in chunks, with progress. */

const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('../actions/suppressions', () => ({ importSuppressions: vi.fn() }))

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'

const csv = (name: string, text: string) => new File([text], name, { type: 'text/csv' })

beforeEach(() => vi.clearAllMocks())

describe('ImportSuppressions', () => {
  it('reads the file, says what it found, and imports it with the reason chosen', async () => {
    vi.mocked(importSuppressions).mockResolvedValue({
      data: { ok: true, added: 1, already: 1, invalid: 0 },
    } as never)
    const user = userEvent.setup()
    render(<ImportSuppressions accountId={ACCOUNT} />)
    expect(screen.queryByRole('button', { name: /to the list/ })).toBeNull()

    await user.upload(
      screen.getByLabelText('The list'),
      csv('unsubscribes.csv', 'email,created\nada@example.com,1\nBOLA@example.com,2\nnobody,3\n'),
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Found 2 addresses in unsubscribes.csv. 1 row has no address we could read, and is left out.',
    )
    await user.click(screen.getByRole('radio', { name: /They unsubscribed/ }))
    await user.click(screen.getByRole('button', { name: 'Add 2 addresses to the list' }))

    expect(importSuppressions).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      reason: 'manual',
      addresses: ['ada@example.com', 'bola@example.com'],
    })
    expect(
      await screen.findByText(/Added 1 address to the list\. 1 was on it already\./),
    ).toBeInTheDocument()
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it('refuses a file with no addresses, or one over 10 MB, before sending anything', async () => {
    const user = userEvent.setup()
    render(<ImportSuppressions accountId={ACCOUNT} />)
    await user.upload(screen.getByLabelText('The list'), csv('empty.csv', 'name\nAda\n'))
    expect(await screen.findByText(/There are no email addresses in this file/)).toBeInTheDocument()
    expect(screen.getByLabelText('The list')).toHaveAttribute('aria-invalid', 'true')

    const big = csv('big.csv', 'ada@example.com')
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 })
    await user.upload(screen.getByLabelText('The list'), big)
    expect(await screen.findByText(/larger than 10 MB/)).toBeInTheDocument()
    expect(importSuppressions).not.toHaveBeenCalled()
  })

  it('stops on a refusal, keeps what was added, and carries on from the chunk that failed', async () => {
    const many = Array.from({ length: 5_003 }, (_, i) => `u${i}@example.com`).join('\n')
    vi.mocked(importSuppressions)
      .mockResolvedValueOnce({ data: { ok: true, added: 5000, already: 0, invalid: 0 } } as never)
      .mockResolvedValueOnce({
        data: { error: 'An account can import 100,000 addresses a day.' },
      } as never)
      .mockResolvedValueOnce({ data: { ok: true, added: 3, already: 0, invalid: 0 } } as never)
    const user = userEvent.setup()
    render(<ImportSuppressions accountId={ACCOUNT} />)
    await user.upload(screen.getByLabelText('The list'), csv('bounces.txt', many))
    await user.click(await screen.findByRole('button', { name: 'Add 5,003 addresses to the list' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An account can import 100,000 addresses a day. 5,000 addresses were added before it stopped.',
    )
    expect(router.refresh).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Carry on from where it stopped' }))

    expect(await screen.findByText(/Added 5,003 addresses to the list\./)).toBeInTheDocument()
    const calls = vi.mocked(importSuppressions).mock.calls.map(([input]) => input.addresses.length)
    expect(calls).toEqual([5000, 3, 3])
    expect(vi.mocked(importSuppressions).mock.calls[0]?.[0].reason).toBe('bounce')
  })
})
