import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.fn()
const state = { result: {} as { data?: unknown; serverError?: string }, isPending: false }
vi.mock('next-safe-action/hooks', () => ({
  useAction: () => ({ execute, ...state }),
}))
vi.mock('../actions/oauth', () => ({ continueWithGoogle: vi.fn() }))

const { GoogleSignIn } = await import('../components/google-sign-in')

beforeEach(() => {
  vi.clearAllMocks()
  state.result = {}
  state.isPending = false
})

describe('GoogleSignIn (FR-A1)', () => {
  it('starts Google sign-in for where the person was going', async () => {
    render(<GoogleSignIn next="/app/checkout" />)
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    expect(execute).toHaveBeenCalledWith({ next: '/app/checkout' })
    expect(screen.getByText('or with your email')).toBeInTheDocument()
  })

  it('says so when Google sent them back without signing them in', () => {
    render(<GoogleSignIn failed />)
    expect(screen.getByText(/Google sign-in did not finish/)).toBeInTheDocument()
  })

  it('shows why sign-in could not start', () => {
    state.result = {
      data: { error: 'Google sign-in is not available just now. Use your email instead.' },
    }
    render(<GoogleSignIn />)
    expect(screen.getByText(/not available just now/)).toBeInTheDocument()
  })

  it('shows that it is opening Google while it waits', () => {
    state.isPending = true
    render(<GoogleSignIn />)
    expect(screen.getByRole('button', { name: /Opening Google/ })).toBeDisabled()
  })
})
