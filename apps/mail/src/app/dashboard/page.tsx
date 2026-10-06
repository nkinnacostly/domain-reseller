import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { StatusPill } from '@/components/common/status-pill'
import { Container } from '@/components/layout/container'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import {
  DayCounts,
  NextStepsList,
  PartError,
  UsageMeter,
} from '@/features/accounts/components/overview-parts'
import { ROLE_LABEL } from '@/features/accounts/lib/roles'
import { STATE_LABEL } from '@/features/accounts/lib/state'
import { isProfileComplete, nextSteps } from '@/features/accounts/lib/steps'
import { formatCount, meter } from '@/features/accounts/lib/usage'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { getOverview } from '@/features/accounts/queries/overview'

export const metadata: Metadata = { title: 'Overview' }

type Params = Promise<{ welcome?: string }>

const card = 'rounded-3xl border border-border bg-card p-5 sm:p-6'

/**
 * Overview (MAIL-SPEC §10): this month's usage against the plan's caps,
 * today's sends, the account's state and what to do next. Every figure comes
 * from SQL; a part that cannot load says so on its own (S11).
 */
async function Overview({ searchParams }: { searchParams: Params }) {
  const [data, { welcome }] = await Promise.all([getCurrentAccount(), searchParams])
  if (!data) return null
  const { account, role } = data.current
  const overview = await getOverview(account.id, role, account.planCode)
  const usage = overview.usage
  const state = STATE_LABEL[account.state]
  const steps = nextSteps({
    state: account.state,
    role,
    verifiedDomains: overview.verifiedDomains ?? 0,
    activeKeys: overview.activeKeys,
    profileComplete: isProfileComplete(account),
  })

  return (
    <Container className="space-y-6 py-6 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Overview</h1>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {account.name} · you are {ROLE_LABEL[role].toLowerCase()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={state.tone}>{state.label}</StatusPill>
          {overview.plan ? <StatusPill tone="neutral">{overview.plan.name} plan</StatusPill> : null}
        </div>
      </div>

      {welcome === '1' ? (
        <FormMessage tone="success">
          <p className="font-medium">Your account is ready</p>
          <p>It starts in the sandbox. The steps below take it from there.</p>
        </FormMessage>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <section aria-labelledby="usage-heading" className={card}>
          <h2 id="usage-heading" className="font-semibold">
            Usage
          </h2>
          {usage ? (
            <div className="mt-4 space-y-6">
              <UsageMeter
                label="This month"
                meter={meter(usage.month.queued, usage.caps.monthly)}
              />
              <UsageMeter label="Today" meter={meter(usage.today.queued, usage.caps.daily)} />
              {usage.month.queued === 0 ? (
                <p className="rounded-2xl bg-muted px-4 py-3 text-pretty text-sm/6 text-muted-foreground">
                  Nothing sent yet this month. Once your app sends, each email counts here by its
                  recipients: an email to three people counts three.
                </p>
              ) : (
                <div>
                  <h3 className="mb-3 text-sm font-medium">Today’s sends</h3>
                  <DayCounts counts={usage.today} />
                </div>
              )}
              <p className="text-xs/5 text-muted-foreground">
                Caps count recipients. Days and months run on Lagos time. At{' '}
                {formatCount(usage.caps.daily)} today or {formatCount(usage.caps.monthly)} this
                month, new emails are refused until the cap resets.
              </p>
            </div>
          ) : (
            <div className="mt-4">
              <PartError what="this month’s usage" retryHref="/dashboard" />
            </div>
          )}
        </section>

        <section id="next-steps" aria-labelledby="steps-heading" className={card}>
          <h2 id="steps-heading" className="font-semibold">
            Next steps
          </h2>
          {overview.verifiedDomains === null ? (
            <div className="mt-4">
              <PartError what="your domains" retryHref="/dashboard" />
            </div>
          ) : (
            <div className="mt-4">
              <NextStepsList steps={steps} />
            </div>
          )}
        </section>
      </div>
    </Container>
  )
}

export default function OverviewPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense
      fallback={
        <Container className="py-6 sm:py-8">
          <PageSkeleton />
        </Container>
      }
    >
      <Overview searchParams={searchParams} />
    </Suspense>
  )
}
