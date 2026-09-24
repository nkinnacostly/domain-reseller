import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LineNameservers } from '../components/line-nameservers'

describe('LineNameservers — the order page (FR-C10)', () => {
  it('shows nothing for a domain that follows the order’s host', () => {
    const { container } = render(
      <LineNameservers line={null} order={['ns1.host.com', 'ns2.host.com']} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows nothing when a domain’s own set is the order’s in another order', () => {
    const { container } = render(
      <LineNameservers
        line={['ns2.host.com', 'ns1.host.com']}
        order={['ns1.host.com', 'ns2.host.com']}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a domain’s own nameservers where they differ', () => {
    render(
      <LineNameservers
        line={['ns1.dns-parking.com', 'ns2.dns-parking.com']}
        order={['ns1.host.com', 'ns2.host.com']}
      />,
    )
    expect(
      screen.getByText('ns1.dns-parking.com, ns2.dns-parking.com').parentElement,
    ).toHaveTextContent(/^Nameservers: ns1\.dns-parking\.com, ns2\.dns-parking\.com$/)
  })
})
