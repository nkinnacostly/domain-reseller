import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { ProfileForm } from '@/features/accounts/components/profile-form'
import { canEditProfile } from '@/features/accounts/lib/roles'
import { isProfileComplete } from '@/features/accounts/lib/steps'
import { formatCount } from '@/features/accounts/lib/usage'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'

export const metadata: Metadata = { title: 'Settings' }

/** The account's profile (MAIL-SPEC §7.1, §7.2 (b), §10). */
async function Profile() {
  const data = await getCurrentAccount()
  if (!data) return null
  const { account, role } = data.current
  const complete = isProfileComplete(account)

  return (
    <section aria-labelledby="profile-heading" className="space-y-4">
      <div>
        <h2 id="profile-heading" className="text-lg font-semibold">
          Account profile
        </h2>
        {account.state === 'sandbox' ? (
          <p className="mt-1 max-w-xl text-pretty text-sm/6 text-muted-foreground">
            {complete ? 'Complete. ' : 'Not complete yet. '}A complete profile is one of the three
            things that take an account out of the sandbox.
          </p>
        ) : null}
      </div>
      {canEditProfile(role) ? (
        <ProfileForm
          accountId={account.id}
          profile={{
            name: account.name,
            website: account.website,
            useCase: account.useCase,
            expectedMonthlyVolume: account.expectedMonthlyVolume,
          }}
        />
      ) : (
        <>
          <dl className="max-w-xl divide-y divide-border rounded-3xl border border-border bg-card">
            {[
              ['Account name', account.name],
              ['Website', account.website ?? 'Not given'],
              ['What it sends', account.useCase ?? 'Not given'],
              [
                'Emails a month, expected',
                account.expectedMonthlyVolume === null
                  ? 'Not given'
                  : formatCount(account.expectedMonthlyVolume),
              ],
            ].map(([term, value]) => (
              <div key={term} className="grid gap-1 px-5 py-3 sm:grid-cols-[12rem_1fr]">
                <dt className="text-sm text-muted-foreground">{term}</dt>
                <dd className="min-w-0 break-words text-sm">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted-foreground">
            Only the account’s owner and admins can change these.
          </p>
        </>
      )}
    </section>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Profile />
    </Suspense>
  )
}
