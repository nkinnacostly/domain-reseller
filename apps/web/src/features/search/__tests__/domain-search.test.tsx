import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainSearch } from '../components/domain-search'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

describe('DomainSearch', () => {
  beforeEach(() => push.mockClear())

  it('labels the input so it is reachable by name', () => {
    render(<DomainSearch />)
    expect(screen.getByLabelText('Find your domain')).toBeInTheDocument()
  })

  it('navigates to the canonical search URL on submit', async () => {
    const user = userEvent.setup()
    render(<DomainSearch />)

    await user.type(screen.getByLabelText('Find your domain'), 'getpaid.com.ng')
    await user.click(screen.getByRole('button', { name: /search/i }))

    expect(push).toHaveBeenCalledWith('/search?q=getpaid.com.ng')
  })

  it('normalises a pasted URL rather than rejecting it', async () => {
    const user = userEvent.setup()
    render(<DomainSearch />)

    await user.type(screen.getByLabelText('Find your domain'), 'https://www.GetPaid.ng/pricing')
    await user.click(screen.getByRole('button', { name: /search/i }))

    expect(push).toHaveBeenCalledWith('/search?q=getpaid.ng')
  })

  it('submits on Enter, not just the button', async () => {
    const user = userEvent.setup()
    render(<DomainSearch />)

    await user.type(screen.getByLabelText('Find your domain'), 'getpaid.ng{Enter}')

    expect(push).toHaveBeenCalledWith('/search?q=getpaid.ng')
  })

  it('refuses to search an empty field and says what to do', async () => {
    const user = userEvent.setup()
    render(<DomainSearch />)

    await user.click(screen.getByRole('button', { name: /search/i }))

    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Type a name to search for')
  })

  it('explains an invalid name instead of failing silently', async () => {
    const user = userEvent.setup()
    render(<DomainSearch />)

    await user.type(screen.getByLabelText('Find your domain'), 'not valid!!')
    await user.click(screen.getByRole('button', { name: /search/i }))

    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/letters, numbers and hyphens/i)
  })

  it('marks the field invalid and links the message for assistive tech', async () => {
    const user = userEvent.setup()
    render(<DomainSearch />)

    await user.click(screen.getByRole('button', { name: /search/i }))

    const input = screen.getByLabelText('Find your domain')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', screen.getByRole('alert').id)
  })

  it('clears the error as soon as the user starts fixing it', async () => {
    const user = userEvent.setup()
    render(<DomainSearch />)

    await user.click(screen.getByRole('button', { name: /search/i }))
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Find your domain'), 'g')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not steal focus unless explicitly asked to', () => {
    render(<DomainSearch />)
    expect(screen.getByLabelText('Find your domain')).not.toHaveFocus()
  })

  it('explains why a lookalike name mixing alphabets is refused (FR-S8)', async () => {
    const user = userEvent.setup()
    render(<DomainSearch />)

    // The second letter is Cyrillic а.
    await user.type(screen.getByLabelText('Find your domain'), 'pаypal.com')
    await user.click(screen.getByRole('button', { name: /search/i }))

    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('mixes letters from different alphabets')
  })

  it('searches an international name by its readable form (FR-S8)', async () => {
    const user = userEvent.setup()
    render(<DomainSearch />)

    await user.type(screen.getByLabelText('Find your domain'), 'Café.com{Enter}')

    expect(push).toHaveBeenCalledWith(`/search?q=${encodeURIComponent('café.com')}`)
  })
})
