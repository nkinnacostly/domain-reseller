import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainSearch } from '../components/domain-search'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

/** The search box on an extension's page, scoped to that extension (FR-PUB1). */
describe('DomainSearch scoped to an extension', () => {
  beforeEach(() => push.mockClear())

  it('says which extension it searches, in the label and beside the field', () => {
    render(<DomainSearch extension="africa" formLabel=".africa domain search" />)

    expect(screen.getByRole('form', { name: '.africa domain search' })).toBeInTheDocument()
    const field = screen.getByLabelText('Find your .africa domain')
    expect(field).toHaveAttribute('placeholder', 'yourbrand')
    expect(screen.getByText('.africa')).toHaveAttribute('aria-hidden', 'true')
  })

  it('searches a bare name in that extension', async () => {
    const user = userEvent.setup()
    render(<DomainSearch extension="com.ng" />)

    await user.type(screen.getByLabelText('Find your .com.ng domain'), 'GetPaid{Enter}')

    expect(push).toHaveBeenCalledWith('/search?q=getpaid.com.ng')
  })

  it('searches a name typed with its own extension as typed', async () => {
    const user = userEvent.setup()
    render(<DomainSearch extension="com" />)

    await user.type(screen.getByLabelText('Find your .com domain'), 'getpaid.africa{Enter}')

    expect(push).toHaveBeenCalledWith('/search?q=getpaid.africa')
  })

  it('gives an example without an extension when the name is invalid', async () => {
    const user = userEvent.setup()
    render(<DomainSearch extension="com" />)

    await user.type(screen.getByLabelText('Find your .com domain'), 'get paid!{Enter}')

    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('for example getpaid')
    expect(screen.getByRole('alert')).not.toHaveTextContent('getpaid.com')
  })
})
