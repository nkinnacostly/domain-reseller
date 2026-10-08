import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/container'
import { formatCount, type Plan } from '@/features/pricing/lib/plans'
import { curlExample, responseExample } from '../lib/send-example'
import { ROUTES } from '../lib/site'
import { CodeSample } from './code-sample'
import { BrandPanel } from './page-hero'

/** The white pill on blue, and its quieter partner. */
export const ON_BRAND_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-brand-foreground px-7 text-sm font-medium text-brand shadow-sm transition-colors hover:bg-brand-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-foreground active:scale-[0.98]'
export const ON_BRAND_SECONDARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-brand-foreground/40 px-7 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-foreground active:bg-brand-foreground/20'

/**
 * The home page's hero: what Mail is, in a sentence, and the one call that
 * sends an email — the real request shape (MAIL-SPEC §1, §6). With the Free
 * plan's row, it leads with that plan (owner, 8 Oct 2026), its numbers read
 * from the database (N5b); without it, it says less.
 */
export function Hero({ free = null }: { free?: Plan | null } = {}) {
  return (
    <BrandPanel
      decoration={
        <div className="absolute -right-48 -bottom-80 hidden size-[44rem] rounded-full bg-brand-arc/45 lg:block" />
      }
    >
      <Container className="relative grid items-center gap-10 pt-28 pb-14 sm:pt-36 sm:pb-20 lg:grid-cols-[1fr_1.05fr] lg:gap-14 lg:pt-40">
        <div className="min-w-0">
          <p className="text-sm font-medium text-brand-muted-foreground">MyDomainsHub Mail</p>
          {free ? (
            <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-brand-foreground px-3.5 py-1.5 text-sm font-semibold text-brand shadow-sm">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-brand" />
              Free plan: {formatCount(free.dailyCap)} emails a day
            </p>
          ) : null}
          <h1 className="mt-3 text-[2.5rem] leading-[1.06] font-bold tracking-[-0.02em] text-balance sm:text-5xl lg:text-[3.5rem]">
            Transactional email for Nigerian businesses
          </h1>
          <p className="mt-5 max-w-xl text-pretty text-brand-muted-foreground sm:text-lg">
            Send receipts, sign-in links and alerts from your own domain with one HTTP call — or
            over SMTP from the app you already have. Plans are priced in naira.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href={ROUTES.signUp} className={ON_BRAND_PRIMARY}>
              {free ? 'Start free' : 'Get started'}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
            <Link href={ROUTES.pricing} className={ON_BRAND_SECONDARY}>
              See pricing
            </Link>
          </div>
          {free ? (
            <p className="mt-4 max-w-xl text-pretty text-sm text-brand-muted-foreground">
              No card needed: {formatCount(free.monthlyCap)} emails a month free, up to{' '}
              {formatCount(free.dailyCap)} a day. New accounts send to their own team until we have
              approved them.
            </p>
          ) : null}
        </div>

        <div id="send-example" className="min-w-0 scroll-mt-8">
          <CodeSample
            label="Sending an email with curl"
            title={
              <>
                <span className="font-semibold text-footer-foreground">POST</span> /api/v1/emails
              </>
            }
            code={curlExample()}
          />
          <p className="mt-3 font-mono text-xs text-brand-muted-foreground">
            → 200 {responseExample()}
          </p>
        </div>
      </Container>
    </BrandPanel>
  )
}
