import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DomainName, domainLabel } from './domain-name'

describe('DomainName (FR-S8)', () => {
  it('shows a plain name as it is', () => {
    const { container } = render(<DomainName name="getpaid.com" />)
    expect(container).toHaveTextContent(/^getpaid\.com$/)
  })

  it('shows an international name in its own script, with the stored form beside it', () => {
    render(<DomainName name="xn--caf-dma.com" />)
    expect(screen.getByText(/café\.com/)).toBeInTheDocument()
    expect(screen.getByText('(xn--caf-dma.com)')).toBeInTheDocument()
  })

  it('reads the same as a single string', () => {
    expect(domainLabel('getpaid.com')).toBe('getpaid.com')
    expect(domainLabel('xn--caf-dma.com')).toBe('café.com (xn--caf-dma.com)')
  })

  it('leaves an xn-- label that decodes to nothing real as it is', () => {
    expect(domainLabel('xn--zz.com')).toBe('xn--zz.com')
    const { container } = render(<DomainName name="xn--zz.com" />)
    expect(container).toHaveTextContent(/^xn--zz\.com$/)
  })
})
