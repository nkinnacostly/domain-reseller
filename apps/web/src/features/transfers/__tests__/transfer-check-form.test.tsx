import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TransferCheckForm } from '../components/transfer-check-form'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

describe('TransferCheckForm', () => {
  beforeEach(() => push.mockReset())

  it('asks for the extension instead of checking a bare name', async () => {
    const user = userEvent.setup()
    render(<TransferCheckForm />)

    await user.type(screen.getByLabelText('Domain to transfer'), 'getpaid{Enter}')

    expect(push).not.toHaveBeenCalled()
    const form = screen.getByRole('form', { name: 'Transfer check' })
    expect(form).toHaveTextContent(/Include the extension/)
    expect(screen.getByLabelText('Domain to transfer')).toHaveAttribute('aria-invalid', 'true')
  })

  it('says what to type when submitted empty', async () => {
    const user = userEvent.setup()
    render(<TransferCheckForm />)

    await user.click(screen.getByRole('button', { name: /check domain/i }))

    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('form', { name: 'Transfer check' })).toHaveTextContent(
      'Type the domain you want to move here',
    )
  })

  it('clears the message as soon as the person starts correcting it', async () => {
    const user = userEvent.setup()
    render(<TransferCheckForm />)
    const field = screen.getByLabelText('Domain to transfer')

    await user.type(field, 'getpaid{Enter}')
    await user.type(field, '.com')

    expect(field).not.toHaveAttribute('aria-invalid')
  })

  it('normalises a pasted URL and goes to the result', async () => {
    const user = userEvent.setup()
    render(<TransferCheckForm />)

    await user.type(
      screen.getByLabelText('Domain to transfer'),
      'https://www.GetPaid.com/about{Enter}',
    )

    expect(push).toHaveBeenCalledWith('/transfer?domain=getpaid.com#check')
  })

  it('still works without JavaScript, as a plain GET to /transfer', () => {
    render(<TransferCheckForm />)
    const form = screen.getByRole('form', { name: 'Transfer check' })
    expect(form).toHaveAttribute('action', '/transfer')
    expect(form).toHaveAttribute('method', 'get')
    expect(screen.getByLabelText('Domain to transfer')).toHaveAttribute('name', 'domain')
  })
})
