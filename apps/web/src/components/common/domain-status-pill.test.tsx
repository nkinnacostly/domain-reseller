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

  it('says "On hold" when the registrar has held the name, over expiry urgency', () => {
    render(<DomainStatusPill status="active" daysUntilExpiry={5} onHold />)
    const pill = screen.getByTestId('domain-status-pill')
    expect(pill.textContent?.trim()).toBe('On hold')
    expect(pill).toHaveAttribute('data-on-hold', 'true')
    expect(pill.textContent).not.toMatch(/Expires in/)
  })

  it('shows the lifecycle label when the name is not on hold', () => {
    render(<DomainStatusPill status="active" onHold={false} />)
    expect(screen.getByTestId('domain-status-pill')).not.toHaveAttribute('data-on-hold')
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
