import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmAction, type ConfirmExtra } from '@/features/admin/components/confirm-action'
import { type AdminResult, adminOutcome, LOST_ANSWER_WORDS } from '@/features/admin/lib/errors'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

type Run = (extra: ConfirmExtra) => Promise<AdminResult<unknown>>

function setup(props: Partial<React.ComponentProps<typeof ConfirmAction>> & { run: Run }) {
  const user = userEvent.setup()
  render(
    <ConfirmAction
      trigger="Approve"
      title="Approve this refund?"
      confirmLabel="Approve ₦19,672.50 refund"
      cancelLabel="Keep it held"
      returnTo="/admin/refunds/x"
      {...props}
    />,
  )
  return user
}

const confirm = () => screen.getByRole('button', { name: /Approve ₦19,672.50 refund/ })

beforeEach(() => vi.clearAllMocks())

describe('ConfirmAction', () => {
  it('needs a reason of at least 10 characters before it can be confirmed', async () => {
    const run = vi.fn<Run>(async () => ({ ok: true, auditId: 1 }))
    const user = setup({ run, reason: 'required' })
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    expect(confirm()).toBeDisabled()
    await user.type(screen.getByLabelText('Reason'), 'too short')
    expect(confirm()).toBeDisabled()
    await user.type(screen.getByLabelText('Reason'), ' — checked the order')
    expect(confirm()).toBeEnabled()
    expect(screen.getByText(/Don't include personal details/)).toBeInTheDocument()
  })

  it('needs the name typed back exactly, and every check ticked', async () => {
    const run = vi.fn<Run>(async () => ({ ok: true, auditId: 1 }))
    const user = setup({
      run,
      typeToConfirm: 'MDH-1234',
      checks: [
        { id: 'no_money', label: "We haven't returned this money through Flutterwave, and won't." },
      ],
    })
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    await user.type(screen.getByLabelText(/to confirm/), 'MDH-123')
    expect(confirm()).toBeDisabled()
    await user.type(screen.getByLabelText(/to confirm/), '4')
    expect(confirm()).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /We haven't returned this money/ }))
    expect(confirm()).toBeEnabled()

    await user.click(confirm())
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ checks: { no_money: true } }))
  })

  it('asks a money action for the six-digit code, labelled and filled by the phone', async () => {
    const run = vi.fn<Run>(async () => ({ ok: true, auditId: 1 }))
    const user = setup({ run, needsCode: true })
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    const field = screen.getByLabelText('Code from your authenticator app')
    expect(field).toHaveAttribute('inputmode', 'numeric')
    expect(field).toHaveAttribute('autocomplete', 'one-time-code')
    await user.type(field, '12a34')
    expect(field).toHaveValue('1234')
    expect(confirm()).toBeDisabled()
    await user.type(field, '56')
    await user.click(confirm())
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ code: '123456' }))
  })

  it('takes a new request key after a refused answer', async () => {
    const run = vi.fn<Run>(async () => ({
      ok: false,
      code: 'WRONG_CODE',
      message: "That code didn't work. Check your authenticator app and try again.",
    }))
    const user = setup({ run })
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await user.click(confirm())
    expect(await screen.findByText(/That code didn't work/)).toBeInTheDocument()
    await user.click(confirm())

    const [first, second] = run.mock.calls.map(([extra]) => extra.requestKey)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(second).not.toBe(first)
  })

  it('keeps the same request key after a lost answer, so a retry replays rather than repeats', async () => {
    const run = vi
      .fn<Run>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: false, code: 'UNKNOWN_OUTCOME', message: LOST_ANSWER_WORDS })
      .mockResolvedValueOnce({ ok: true, auditId: 9, replayed: true })
    const user = setup({ run, successMessage: 'Refund approved.' })
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    await user.click(confirm())
    expect(await screen.findByText(LOST_ANSWER_WORDS)).toBeInTheDocument()
    await user.click(confirm())
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await user.click(confirm())

    const keys = run.mock.calls.map(([extra]) => extra.requestKey)
    expect(new Set(keys).size).toBe(1)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Refund approved. (It had already gone through.)',
    )
    expect(refresh).toHaveBeenCalled()
  })

  it('gives a fresh key each time it is opened', async () => {
    const run = vi.fn<Run>(async () => ({ ok: true, auditId: 1 }))
    const user = setup({ run })
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await user.click(confirm())
    await user.click(await screen.findByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await user.click(confirm())
    const [first, second] = run.mock.calls.map(([extra]) => extra.requestKey)
    expect(second).not.toBe(first)
  })

  it('focuses Cancel first when the action is destructive', async () => {
    const run = vi.fn<Run>(async () => ({ ok: true, auditId: 1 }))
    const user = setup({ run, destructive: true })
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep it held' })).toHaveFocus())
  })

  it('links to enter a code when the server asks for one, and comes back here', async () => {
    const run = vi.fn<Run>(async () => ({
      ok: false,
      code: 'REFUSED',
      message: "Confirm it's you with the code from your authenticator app to continue.",
    }))
    const user = setup({ run })
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await user.click(confirm())
    expect(await screen.findByRole('link', { name: 'Enter a code' })).toHaveAttribute(
      'href',
      '/verify?next=%2Fadmin%2Frefunds%2Fx',
    )
  })

  it('holds what the action needs inside the dialog, and waits for it before it confirms', async () => {
    const run = vi.fn<Run>(async () => ({ ok: true, auditId: 5 }))
    const user = userEvent.setup()
    function WithChoice() {
      const [picked, setPicked] = useState(false)
      return (
        <ConfirmAction
          trigger="Resolve"
          title="Mark this incident resolved?"
          confirmLabel="Mark resolved"
          returnTo="/admin/refunds/incidents"
          canConfirm={picked}
          notReadyHint="Choose what happened first."
          run={run}
        >
          {/* A form of its own: the dialog's form must not wrap it. */}
          <form aria-label="Check" onSubmit={(event) => event.preventDefault()}>
            <label>
              <input type="checkbox" checked={picked} onChange={() => setPicked(!picked)} />
              The payment is now recorded
            </label>
          </form>
        </ConfirmAction>
      )
    }
    render(<WithChoice />)
    // The trigger opens it whatever was chosen: the choice is made inside.
    await user.click(screen.getByRole('button', { name: 'Resolve' }))
    const dialog = screen.getByRole('dialog', { name: 'Mark this incident resolved?' })
    const form = within(dialog).getByRole('form', { name: 'Check' })
    expect(form.parentElement?.closest('form')).toBeNull()
    const button = within(dialog).getByRole('button', { name: 'Mark resolved' })
    expect(button).toBeDisabled()
    expect(within(dialog).getByText('Choose what happened first.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('checkbox', { name: /payment is now recorded/ }))
    expect(button).toBeEnabled()
    expect(within(dialog).queryByText('Choose what happened first.')).toBeNull()
    await user.click(button)
    expect(run).toHaveBeenCalledTimes(1)
    // Once done, the choice is spent: only the outcome and Close remain.
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Done.')
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
  })

  it('shows success in words and refreshes the page', async () => {
    const run = vi.fn<Run>(async () => ({ ok: true, auditId: 4 }))
    const user = setup({ run, successMessage: 'Refund approved.' })
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await user.click(confirm())
    expect(await screen.findByRole('status')).toHaveTextContent('Refund approved.')
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('adminOutcome', () => {
  it('passes an answer through, and words what the client could not read', () => {
    expect(adminOutcome({ data: { ok: true, auditId: 1 } })).toEqual({ ok: true, auditId: 1 })
    expect(adminOutcome({ serverError: "Your admin role can't do this. Ask the owner." })).toEqual({
      ok: false,
      code: 'REFUSED',
      message: "Your admin role can't do this. Ask the owner.",
    })
    expect(
      adminOutcome({ serverError: 'Something went wrong on our end. Please try again.' }),
    ).toEqual({
      ok: false,
      code: 'UNKNOWN_OUTCOME',
      message: LOST_ANSWER_WORDS,
    })
    expect(
      adminOutcome({
        validationErrors: { reason: { _errors: ['Give a reason of at least 10 characters.'] } },
      }),
    ).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Give a reason of at least 10 characters.',
    })
    expect(adminOutcome({ validationErrors: {} })).toMatchObject({
      message: 'Check what you entered and try again.',
    })
    expect(adminOutcome(undefined)).toMatchObject({ code: 'UNKNOWN_OUTCOME' })
  })
})
