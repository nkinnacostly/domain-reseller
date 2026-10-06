import { ArrowLeft, FlaskConical } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { OnboardingForm } from '@/features/accounts/components/onboarding-form'
import { getMemberships } from '@/features/accounts/queries/accounts'

export const metadata: Metadata = { title: 'Create a Mail account' }

/**
 * Onboarding (MAIL-SPEC §7.1, §7.2): after the first sign-in with no account,
 * or "Create another account" from the switcher. The account starts in the
 * sandbox, and this page says what that means and what lets it out.
 */
async function Onboarding() {
  const data = await getMemberships()
  const hasAccounts = (data?.memberships.length ?? 0) > 0

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-12">
      <div className="min-w-0">
        {hasAccounts ? (
          <Link
            href="/dashboard"
            className="mb-4 inline-flex min-h-11 items-center gap-1.5 rounded-full text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to the dashboard
          </Link>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          {hasAccounts ? 'Create another Mail account' : 'Set up your Mail account'}
        </h1>
        <p className="mt-2 max-w-xl text-pretty text-sm/6 text-muted-foreground">
          One account per business or project: its own domains, keys, members and log. You will be
          its owner.
        </p>
        <div className="mt-6 max-w-xl">
          <OnboardingForm />
        </div>
      </div>

      <aside
        aria-labelledby="sandbox-heading"
        className="h-fit rounded-3xl border border-brand-subtle-border bg-brand-subtle p-6"
      >
        <span className="grid size-11 place-items-center rounded-2xl bg-background text-brand-ink">
          <FlaskConical className="size-5" aria-hidden="true" />
        </span>
        <h2 id="sandbox-heading" className="mt-4 font-semibold">
          It starts in the sandbox
        </h2>
        <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
          A new account can send only to its own members’ confirmed email addresses, with a small
          daily cap, on the Free plan. That lets you try everything without risk to anyone.
        </p>
        <h3 className="mt-5 text-sm font-semibold">What takes it out</h3>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-pretty text-sm/6 text-muted-foreground">
          <li>A verified domain to send from.</li>
          <li>A complete profile — this form completes it.</li>
          <li>Approval by our team, who read the profile. Reviews open before launch.</li>
        </ol>
      </aside>
    </div>
  )
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div aria-hidden="true" className="max-w-xl space-y-4">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-96 rounded-3xl" />
        </div>
      }
    >
      <Onboarding />
    </Suspense>
  )
}
