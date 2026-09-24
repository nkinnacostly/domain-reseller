import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Accordion } from '@/components/ui/accordion'
import { FaqItem } from './faq-item'

describe('FaqItem', () => {
  it('keeps a closed answer in the page, so crawlers that open nothing still read it', () => {
    render(
      <Accordion type="single" collapsible>
        <FaqItem question="Do I need hosting?">No, you can point it later.</FaqItem>
      </Accordion>,
    )
    const question = screen.getByRole('button', { name: 'Do I need hosting?' })
    expect(question).toHaveAttribute('aria-expanded', 'false')
    const answer = screen.getByText('No, you can point it later.')
    expect(answer.closest('[data-slot="accordion-content"]')).toHaveAttribute(
      'data-state',
      'closed',
    )
  })

  it('opens and closes like any accordion', async () => {
    render(
      <Accordion type="single" collapsible>
        <FaqItem question="Do I need hosting?">No, you can point it later.</FaqItem>
      </Accordion>,
    )
    const question = screen.getByRole('button', { name: 'Do I need hosting?' })
    await userEvent.click(question)
    expect(question).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByText('No, you can point it later.').closest('[data-slot="accordion-content"]'),
    ).toHaveAttribute('data-state', 'open')
  })
})
