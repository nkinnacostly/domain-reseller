import { EMAIL_STATUSES } from '@dr/shared/mail'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EMAIL_STATUS, EmailStatusPill } from './email-status'
import { StatusPill, TONES } from './status-pill'

describe('StatusPill', () => {
  it.each(TONES)(
    '%s: the tone’s tint and ink, and the words — colour is never the only signal (S8)',
    (tone) => {
      render(<StatusPill tone={tone}>In words</StatusPill>)
      const pill = screen.getByText('In words')
      expect(pill).toHaveAttribute('data-tone', tone)
      expect(pill).toHaveClass(`bg-tone-${tone}`, `text-tone-${tone}-foreground`)
    },
  )
})

describe('EmailStatusPill', () => {
  it('has words and a tone for every status an email can have', () => {
    expect(Object.keys(EMAIL_STATUS).sort()).toEqual([...EMAIL_STATUSES].sort())
    render(<EmailStatusPill status="complained" />)
    expect(screen.getByText('Marked as spam')).toHaveAttribute('data-tone', 'warning')
  })

  it('shows a bounce as danger and a delivery as success', () => {
    render(
      <>
        <EmailStatusPill status="bounced" />
        <EmailStatusPill status="delivered" />
      </>,
    )
    expect(screen.getByText('Bounced')).toHaveAttribute('data-tone', 'danger')
    expect(screen.getByText('Delivered')).toHaveAttribute('data-tone', 'success')
  })
})
