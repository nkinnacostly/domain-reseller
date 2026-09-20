import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DomainStatusPill } from './domain-status-pill'

describe('DomainStatusPill', () => {
  it('labels an active domain', () => {
    render(<DomainStatusPill status="active" />)
    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  it('renders a human label for every lifecycle state, never a raw enum', () => {
    const states = ['redemption', 'pending_verification', 'transferred_away'] as const
    for (const status of states) {
      const { unmount } = render(<DomainStatusPill status={status} />)
      expect(screen.getByTestId('domain-status-pill').textContent).not.toMatch(/_/)
      unmount()
    }
  })

  it('escalates an active domain to urgency messaging when expiry is close', () => {
    render(<DomainStatusPill status="active" daysUntilExpiry={5} />)
    expect(screen.getByText('Expires in 5 days')).toBeInTheDocument()
    expect(screen.getByTestId('domain-status-pill')).toHaveAttribute('data-urgency', 'urgent')
  })

  it('leaves a comfortably distant expiry alone', () => {
    render(<DomainStatusPill status="active" daysUntilExpiry={200} />)
    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  it('does not let expiry urgency override a non-active state', () => {
    render(<DomainStatusPill status="redemption" daysUntilExpiry={2} />)
    expect(screen.getByText('Redemption')).toBeInTheDocument()
  })

  it('conveys meaning in text, not colour alone (WCAG 1.4.1)', () => {
    render(<DomainStatusPill status="expired_grace" />)
    const pill = screen.getByTestId('domain-status-pill')
    expect(pill.textContent?.trim()).toBe('Expired')
    expect(pill.querySelector('[aria-hidden="true"]')).toBeTruthy()
  })
})
