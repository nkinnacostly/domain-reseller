import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CapRules, PricingFaq } from '../components/cap-rules'
import { PlanCards } from '../components/plan-cards'
import { CAP_RULES, PRICING_INTRO, pricingFaqs } from '../lib/copy'
import { toCatalogue } from '../lib/plans'
import { ROWS } from './fixtures'

const catalogue = toCatalogue(ROWS)

describe('the plan cards (MAIL-SPEC §8; N8 for Mail)', () => {
  it('shows each offered plan with its price before VAT and every cap', () => {
    render(<PlanCards catalogue={catalogue} />)
    const plans = [...screen.getByRole('list', { name: 'Plans' }).querySelectorAll('[data-plan]')]
    expect(plans.map((card) => card.getAttribute('data-plan'))).toEqual(['free', 'starter', 'pro'])
    expect(document.body).not.toHaveTextContent('Scale')

    const starter = plans[1] as HTMLElement
    expect(within(starter).getByTestId('plan-price')).toHaveTextContent(/₦\s?20,000/)
    expect(starter).toHaveTextContent('a month, before VAT')
    for (const line of [
      '50,000 emails a month',
      'Up to 5,000 a day',
      '5 sending domains',
      '3 team members',
      'Email log kept 30 days',
    ]) {
      expect(starter).toHaveTextContent(line)
    }
    expect(document.body).toHaveTextContent('VAT 7.5% is added at checkout.')
  })

  it('offers the Free plan now, and says paid plans are not on sale yet', () => {
    render(<PlanCards catalogue={catalogue} />)
    expect(screen.getByRole('link', { name: 'Start free' })).toHaveAttribute('href', '/sign-up')
    expect(screen.getAllByText('Not on sale yet')).toHaveLength(2)
    expect(screen.queryByRole('link', { name: /^Choose / })).toBeNull()
  })

  it('offers each paid plan once paid plans are on sale', () => {
    render(<PlanCards catalogue={catalogue} paidPlansOnSale />)
    expect(screen.getByRole('link', { name: 'Choose Starter' })).toBeInTheDocument()
    expect(screen.queryByText('Not on sale yet')).toBeNull()
  })

  it('withholds prices and says what to do when the plans could not be read (S11)', () => {
    render(<PlanCards catalogue={null} />)
    expect(screen.getByRole('status')).toHaveTextContent('The plans could not be loaded just now.')
    expect(document.body).not.toHaveTextContent('₦')
    expect(screen.getByRole('link', { name: 'hello@mydomainshub.com' })).toHaveAttribute(
      'href',
      'mailto:hello@mydomainshub.com',
    )
  })

  it('says so when no plan is offered (S11)', () => {
    render(<PlanCards catalogue={{ plans: [], updatedAt: null }} />)
    expect(screen.getByRole('status')).toHaveTextContent('No plans are on offer right now.')
  })
})

describe('what happens at a cap', () => {
  it('names 80% and 100%, the reset times and that there is no overage', () => {
    render(<CapRules />)
    expect(screen.getByRole('heading', { name: 'What happens at a cap' })).toBeInTheDocument()
    expect(CAP_RULES.map((rule) => rule.level)).toEqual(['80% of a cap', '100% of a cap'])
    const text = document.body.textContent ?? ''
    expect(text).toContain('we email its owners and show a banner in the dashboard')
    expect(text).toContain('quota_exceeded (HTTP 429)')
    expect(text).toContain('midnight, Lagos time')
    expect(text).toContain('There is no overage')
    expect(text).toContain('An email to three people counts as three')
  })
})

describe('the pricing questions', () => {
  it('keeps every answer in the HTML, even closed (CLAUDE.md §15)', () => {
    const faqs = pricingFaqs(catalogue)
    render(<PricingFaq faqs={faqs} />)
    for (const faq of faqs) {
      expect(screen.getByText(faq.a)).toBeInTheDocument()
    }
    const trigger = screen.getByRole('button', { name: 'Is VAT included?' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('quotes each plan’s retention and the free plan from the rows', () => {
    const faqs = pricingFaqs(catalogue)
    const answer = (q: string) => faqs.find((faq) => faq.q === q)?.a ?? ''
    expect(answer('How long do you keep my emails?')).toContain(
      'Free 7 days, Starter 30 days, Pro 30 days',
    )
    expect(answer('How long do you keep my emails?')).toContain(
      'Message bodies are deleted 72 hours after sending.',
    )
    expect(answer('Is there a free plan?')).toBe(
      'Yes. Free includes 3,000 emails a month, up to 100 a day, 1 sending domain, 1 team member, email log kept 7 days, at ₦0.',
    )
    expect(answer('Why can I send fewer emails a day than my plan allows?')).toContain(
      'starts at 1,000',
    )
  })

  it('without the rows, still answers — and claims no free plan', () => {
    const faqs = pricingFaqs(null)
    expect(faqs.some((faq) => faq.q === 'Is there a free plan?')).toBe(false)
    expect(faqs.find((faq) => faq.q === 'How long do you keep my emails?')?.a).toContain(
      'shown with each plan',
    )
  })

  it('the intro states caps per recipient and VAT at checkout', () => {
    expect(PRICING_INTRO).toBe(
      'Every plan has a monthly and a daily cap, counted per recipient. Prices are for a month, before VAT; VAT 7.5% is added at checkout.',
    )
  })
})
