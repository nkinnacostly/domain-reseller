import { emailIdSchema, idempotencyKeySchema, sendEmailSchema } from '@dr/shared/mail'
import { Bell } from '@phosphor-icons/react/ssr'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PlanCatalogue } from '@/features/pricing/lib/plans'
import { CodeSample } from '../components/code-sample'
import { Deliverability, SAFEGUARDS } from '../components/deliverability'
import { FinalCta } from '../components/final-cta'
import { Hero } from '../components/hero'
import { HowItWorks, STEPS } from '../components/how-it-works'
import { PageHero } from '../components/page-hero'
import { PlansTeaser } from '../components/plans-teaser'
import { PreLaunchNotice } from '../components/pre-launch-notice'
import {
  curlExample,
  EXAMPLE_EMAIL,
  EXAMPLE_IDEMPOTENCY_KEY,
  EXAMPLE_RESPONSE,
  responseExample,
} from '../lib/send-example'

const CATALOGUE: PlanCatalogue = {
  plans: [
    {
      code: 'free',
      name: 'Free',
      priceKobo: 0,
      monthlyCap: 3000,
      dailyCap: 100,
      maxDomains: 1,
      maxMembers: 1,
      logRetentionDays: 7,
    },
    {
      code: 'starter',
      name: 'Starter',
      priceKobo: 2_000_000,
      monthlyCap: 50_000,
      dailyCap: 5000,
      maxDomains: 5,
      maxMembers: 3,
      logRetentionDays: 30,
    },
  ],
  updatedAt: '2026-10-06T09:00:00.000Z',
}

describe('the send example (MAIL-SPEC §1, §6)', () => {
  it('is a request the API accepts, in the shape packages/shared validates', () => {
    expect(sendEmailSchema.safeParse(EXAMPLE_EMAIL).success).toBe(true)
    expect(idempotencyKeySchema.safeParse(EXAMPLE_IDEMPOTENCY_KEY).success).toBe(true)
    expect(emailIdSchema.safeParse(EXAMPLE_RESPONSE.id).success).toBe(true)
  })

  it('posts to the v1 emails endpoint with a bearer key, never a real one', () => {
    const curl = curlExample()
    expect(curl).toContain('curl -X POST https://emails.mydomainshub.com/api/v1/emails \\')
    expect(curl).toContain('-H "Authorization: Bearer mdh_live_…"')
    expect(curl).toContain('-H "Content-Type: application/json"')
    expect(curl).toContain(`-H "Idempotency-Key: ${EXAMPLE_IDEMPOTENCY_KEY}"`)
    const body = curl.slice(curl.indexOf("-d '") + 4, curl.lastIndexOf("'"))
    expect(JSON.parse(body)).toEqual(EXAMPLE_EMAIL)
    expect(JSON.parse(responseExample())).toEqual(EXAMPLE_RESPONSE)
  })
})

describe('the home page sections', () => {
  it('the hero says what Mail is and shows the call in a focusable scroll box', () => {
    render(<Hero />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Transactional email for Nigerian businesses',
    )
    const code = screen.getByRole('region', { name: 'Sending an email with curl' })
    expect(code).toHaveAttribute('tabindex', '0')
    expect(code).toHaveTextContent('/api/v1/emails')
    expect(screen.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/sign-up')
    expect(screen.getByRole('link', { name: 'See pricing' })).toHaveAttribute('href', '/pricing')
  })

  it('the hero leads with the Free plan, its numbers from the plan row (N5b)', () => {
    const free = CATALOGUE.plans.find((plan) => plan.priceKobo === 0)
    render(<Hero free={free ?? null} />)
    expect(document.body).toHaveTextContent('Free plan: 100 emails a day')
    expect(screen.getByRole('link', { name: 'Start free' })).toHaveAttribute('href', '/sign-up')
    expect(document.body).toHaveTextContent(
      'No card needed: 3,000 emails a month free, up to 100 a day. New accounts send to their own team until we have approved them.',
    )
  })

  it('a code sample without a title is still named', () => {
    render(<CodeSample label="Example" code="echo hi" />)
    expect(screen.getByRole('region', { name: 'Example' })).toHaveTextContent('echo hi')
    expect(screen.queryByRole('figure')?.querySelector('figcaption')).toBeFalsy()
  })

  it('how it works: verify, key, send, watch', () => {
    render(<HowItWorks />)
    const steps = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(steps).toHaveLength(4)
    expect(STEPS.map((step) => step.title)).toEqual([
      'Verify your domain',
      'Create an API key',
      'Send',
      'Watch deliveries',
    ])
    expect(steps[2]).toHaveTextContent('up to 50 recipients')
    expect(steps[1]).toHaveTextContent('mdh_live_')
  })

  it('deliverability: isolation, sandbox, suppression and pausing, with the spec’s numbers', () => {
    render(<Deliverability />)
    expect(screen.getAllByRole('listitem')).toHaveLength(SAFEGUARDS.length)
    const text = document.body.textContent ?? ''
    expect(text).toContain('own Amazon SES tenant')
    expect(text).toContain('up to 100 a day')
    expect(text).toContain('at least 500 sends')
    expect(text).toContain('2% bounces or 0.05% complaints')
    expect(text).toContain('pause its sending at 4% or 0.08%')
    expect(text).toContain('A person, not code, decides when it resumes')
  })

  it('the plans teaser quotes the plan rows, and says less without them', () => {
    const { unmount } = render(<PlansTeaser catalogue={CATALOGUE} />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Start free, upgrade when you grow',
    )
    expect(document.body).toHaveTextContent(
      'The Free plan sends 3,000 emails a month, up to 100 a day, for 1 sending domain. No card needed.',
    )
    const facts = screen.getByLabelText('The Free plan')
    expect(facts).toHaveTextContent('₦0a month')
    expect(facts).toHaveTextContent('100emails a day')
    expect(screen.getByRole('link', { name: 'Start free' })).toHaveAttribute('href', '/sign-up')
    expect(document.body).toHaveTextContent(
      /Paid plans from ₦20,000 a month before VAT; VAT 7\.5% is added at checkout\./,
    )
    unmount()

    render(<PlansTeaser catalogue={null} />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Plans with caps you can see',
    )
    expect(document.body).not.toHaveTextContent('₦')
    expect(screen.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/pricing')
  })

  it('the teaser words several domains in the plural', () => {
    render(
      <PlansTeaser
        catalogue={{
          plans: [{ ...(CATALOGUE.plans[0] as PlanCatalogue['plans'][number]), maxDomains: 2 }],
          updatedAt: null,
        }}
      />,
    )
    expect(document.body).toHaveTextContent('for 2 sending domains.')
  })

  it('the closing call to action', () => {
    const { unmount } = render(<FinalCta hasFreePlan />)
    expect(screen.getByRole('link', { name: 'Start free' })).toHaveAttribute('href', '/sign-up')
    expect(document.body).toHaveTextContent('on the Free plan — no card needed')
    unmount()
    render(<FinalCta />)
    expect(screen.getByRole('link', { name: 'Get started' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Send your first email' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Read the docs' })).toHaveAttribute('href', '/docs')
  })

  it('says Mail is not open yet, until it is (N9b)', () => {
    const { unmount } = render(<PreLaunchNotice isOpen={false} />)
    expect(screen.getByRole('complementary', { name: 'Not open yet' })).toHaveTextContent(
      'Paid plans are not on sale',
    )
    unmount()
    const { container } = render(<PreLaunchNotice isOpen />)
    expect(container).toBeEmptyDOMElement()
    // Mail is open (owner, 7 Oct 2026): the default draws nothing.
    expect(render(<PreLaunchNotice />).container).toBeEmptyDOMElement()
  })

  it('a page hero carries its eyebrow, intro and up to three icons', () => {
    const { container } = render(
      <PageHero
        eyebrow="Eyebrow"
        title="Title"
        intro={<p>Intro</p>}
        icons={[Bell, Bell, Bell, Bell]}
      >
        <p>Below</p>
      </PageHero>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument()
    expect(screen.getByText('Eyebrow')).toBeInTheDocument()
    expect(screen.getByText('Below')).toBeInTheDocument()
    expect(container.querySelectorAll('[aria-hidden="true"] > span svg')).toHaveLength(3)
  })

  it('a page hero needs no eyebrow or icons', () => {
    render(<PageHero title="Plain" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Plain' })).toBeInTheDocument()
  })
})
