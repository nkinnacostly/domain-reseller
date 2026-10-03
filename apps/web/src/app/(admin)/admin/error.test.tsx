import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminError from './error'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

afterEach(() => vi.restoreAllMocks())

describe('the admin error page', () => {
  it('offers Try again and a way back, each a 44 px control with hover, focus and pressed states (S7, S12)', async () => {
    const reset = vi.fn()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <AdminError
        error={Object.assign(new Error('refund 123 for ada'), { digest: 'd1' })}
        reset={reset}
      />,
    )

    const back = screen.getByRole('link', { name: 'Back to the admin overview' })
    expect(back).toHaveAttribute('href', '/admin')
    for (const state of [/\bh-11\b/, /hover:/, /focus-visible:outline/, /active:scale-/]) {
      expect(back.className).toMatch(state)
    }
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reset).toHaveBeenCalledTimes(1)
    // The digest only: the message may name a record (N13).
    expect(log).toHaveBeenCalledWith('admin page error', 'd1')
    expect(JSON.stringify(log.mock.calls)).not.toContain('ada')
  })
})
