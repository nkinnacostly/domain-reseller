import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WhoisForm } from '../components/whois-form'
import { WhoisGuide } from '../components/whois-guide'
import { WhoisPending } from '../components/whois-pending'

const push = vi.fn()
let params = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => params,
}))

describe('WhoisForm', () => {
  beforeEach(() => push.mockReset())

  it('asks for the extension instead of looking up a bare name', async () => {
    const user = userEvent.setup()
    render(<WhoisForm />)

    await user.type(screen.getByLabelText('Domain to look up'), 'getpaid{Enter}')

    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('form', { name: 'WHOIS lookup' })).toHaveTextContent(
      /Include the extension/,
    )
    expect(screen.getByLabelText('Domain to look up')).toHaveAttribute('aria-invalid', 'true')
  })

  it('says what to type when submitted empty', async () => {
    const user = userEvent.setup()
    render(<WhoisForm />)

    await user.click(screen.getByRole('button', { name: /look up/i }))

    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('form', { name: 'WHOIS lookup' })).toHaveTextContent(
      'Type the domain you want to look up',
    )
  })

  it('clears the message as soon as the person starts correcting it', async () => {
    const user = userEvent.setup()
    render(<WhoisForm />)
    const field = screen.getByLabelText('Domain to look up')

    await user.type(field, 'getpaid{Enter}')
    await user.type(field, '.com')

    expect(field).not.toHaveAttribute('aria-invalid')
  })

  it('normalises a pasted URL and goes to the result', async () => {
    const user = userEvent.setup()
    render(<WhoisForm />)

    await user.type(screen.getByLabelText('Domain to look up'), 'https://www.GetPaid.com/x{Enter}')

    expect(push).toHaveBeenCalledWith('/whois?domain=getpaid.com#result')
  })

  it('still works without JavaScript, as a plain GET to /whois', () => {
    render(<WhoisForm />)
    const form = screen.getByRole('form', { name: 'WHOIS lookup' })
    expect(form).toHaveAttribute('action', '/whois')
    expect(form).toHaveAttribute('method', 'get')
    expect(screen.getByLabelText('Domain to look up')).toHaveAttribute('name', 'domain')
    expect(form).toHaveAttribute('data-enhanced', 'true')
  })
})

describe('WhoisPending', () => {
  it('shows a skeleton while a linked lookup is on its way', () => {
    params = new URLSearchParams('domain=getpaid.com')
    render(<WhoisPending />)
    expect(screen.getByRole('status', { name: 'Looking up the domain' })).toBeInTheDocument()
  })

  it('shows nothing when nothing has been asked', () => {
    params = new URLSearchParams()
    const { container } = render(<WhoisPending />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('WhoisGuide', () => {
  it('says what a lookup shows, where it comes from, and why owners are hidden', () => {
    render(<WhoisGuide />)
    expect(screen.getByRole('heading', { name: 'What a lookup shows' })).toBeInTheDocument()
    expect(screen.getByText(/keep an answer for up to 15 minutes/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Registration Data Policy' })).toHaveAttribute(
      'href',
      expect.stringContaining('icann.org'),
    )
    expect(screen.getByText(/We never show an owner/)).toBeInTheDocument()
  })
})
