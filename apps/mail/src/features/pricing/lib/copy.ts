import type { Faq } from '@/features/marketing/components/faq'
import { SAFETY } from '@/features/marketing/lib/site'
import { BUSINESS } from '@/lib/business'
import { formatCount, freePlan, type PlanCatalogue, planFeatures } from './plans'

/**
 * The pricing page's words (MAIL-SPEC §8). N8 here: every plan shows its
 * caps and what happens at a cap. Plain strings, because the same words go
 * into the page's structured data (CLAUDE.md §15: markup repeats the page).
 */

export const PRICING_INTRO = `Every plan has a monthly and a daily cap, counted per recipient. Prices are for a month, before VAT; VAT ${BUSINESS.vatRate} is added at checkout.`

/** How a cap resets: the API's own words for `quota_exceeded` (Lagos time). */
export const CAP_RESETS =
  'The daily cap resets at midnight, Lagos time; the monthly cap on the 1st of the month.'

/** §8: no overage in v1 — a banner and an email at 80%, `quota_exceeded` at 100%. */
export const CAP_RULES = [
  {
    level: '80% of a cap',
    title: 'We tell you',
    body: 'When an account has used 80% of its daily or monthly cap, we email its owners and show a banner in the dashboard. Sending carries on.',
  },
  {
    level: '100% of a cap',
    title: 'Sending stops until it resets',
    body: `The API refuses further emails with quota_exceeded (HTTP 429), and nothing is queued. ${CAP_RESETS} There is no overage: going over is never charged.`,
  },
] as const

export const COUNTING =
  'An email to three people counts as three, across to, cc and bcc — as Amazon SES counts it.'

/** The questions under the plans. Answers that quote a plan read it from the rows. */
export function pricingFaqs(catalogue: PlanCatalogue | null): Faq[] {
  const free = catalogue ? freePlan(catalogue.plans) : null
  const retention =
    catalogue && catalogue.plans.length > 0
      ? `The log — recipients, subject, status and events — is kept for the plan’s retention: ${catalogue.plans
          .map((plan) => `${plan.name} ${formatCount(plan.logRetentionDays)} days`)
          .join(', ')}.`
      : 'The log — recipients, subject, status and events — is kept for the plan’s retention, shown with each plan.'

  return [
    {
      q: 'What counts as one email?',
      a: `Each recipient. ${COUNTING} Daily and monthly caps both count this way.`,
    },
    {
      q: 'What happens when I reach a cap?',
      a: `At 80% of either cap we email the account’s owners and show a banner in the dashboard. At 100%, the API refuses further emails with quota_exceeded (HTTP 429) until the cap resets. ${CAP_RESETS} There is no overage billing.`,
    },
    {
      q: 'Why can I send fewer emails a day than my plan allows?',
      a: `A new account starts in the sandbox: it sends only to its own team’s confirmed addresses, up to ${formatCount(SAFETY.sandboxDailyCap)} a day, until we have reviewed it. Once approved, its daily cap starts at ${formatCount(SAFETY.warmupStartCap)} — or the plan’s, if lower — and doubles each day its bounces stay under ${SAFETY.warmupBounce} and complaints under ${SAFETY.warmupComplaint}, until it reaches the plan’s cap.`,
    },
    {
      q: 'Is VAT included?',
      a: `No. Prices are for a month, before VAT. VAT at ${BUSINESS.vatRate} is added at checkout.`,
    },
    {
      q: 'How long do you keep my emails?',
      a: `Message bodies are deleted 72 hours after sending. ${retention}`,
    },
    ...(free
      ? [
          {
            q: 'Is there a free plan?',
            a: `Yes. ${free.name} includes ${planFeatures(free)
              .map((line) => line.charAt(0).toLowerCase() + line.slice(1))
              .join(', ')}, at ₦0.`,
          },
        ]
      : []),
  ]
}
