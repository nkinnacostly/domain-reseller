import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BUSINESS } from '@/lib/business'
import { RegistryHoldNotice } from '../components/registry-hold-notice'

describe('RegistryHoldNotice', () => {
  it('says the domain is on hold, what that stops, and who to ask', () => {
    render(<RegistryHoldNotice domainName="getpaid.com" />)
    const notice = screen.getByRole('region', { name: 'This domain is on hold' })
    expect(notice).toHaveTextContent('The registrar has put getpaid.com on hold')
    expect(notice).toHaveTextContent('any website or email on it is offline')
    expect(screen.getByRole('link', { name: BUSINESS.email })).toHaveAttribute(
      'href',
      `mailto:${BUSINESS.email}`,
    )
  })

  it('names itself by its heading, and keeps the icon from screen readers', () => {
    const { container } = render(<RegistryHoldNotice domainName="getpaid.com" />)
    expect(
      screen.getByRole('heading', { level: 2, name: 'This domain is on hold' }),
    ).toBeInTheDocument()
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})
