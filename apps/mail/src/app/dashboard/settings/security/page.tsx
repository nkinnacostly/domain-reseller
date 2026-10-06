import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { PartError } from '@/features/accounts/components/overview-parts'
import { ChangePasswordForm } from '@/features/auth/components/change-password-form'
import { TwoFactorPanel } from '@/features/auth/components/two-factor-panel'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Your security' }

type Params = Promise<{ reset?: string }>

/**
 * Your own security (MAIL-SPEC §10 Settings): password and two-factor for
 * your sign-in — the shop's sign-in too (M5), so a change here applies there.
 */
async function Security({ searchParams }: { searchParams: Params }) {
  const [{ reset }, supabase] = await Promise.all([searchParams, createClient()])
  const [{ data: userData }, { data: factors, error }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.mfa.listFactors(),
  ])
  const factorId = factors?.totp.find((factor) => factor.status === 'verified')?.id ?? null

  return (
    <div className="space-y-10">
      <p className="max-w-2xl text-pretty text-sm/6 text-muted-foreground">
        These protect your sign-in
        {userData.user?.email ? (
          <>
            , <span className="font-medium text-foreground">{userData.user.email}</span>,
          </>
        ) : null}{' '}
        in every Mail account you belong to and in the MyDomainsHub domain shop: one password and
        one authenticator for both.
      </p>
      {reset === '1' ? (
        <FormMessage tone="success">
          Your new password is saved, and every other device has been signed out.
        </FormMessage>
      ) : null}

      <section aria-labelledby="password-heading" className="max-w-xl space-y-4">
        <h2 id="password-heading" className="text-lg font-semibold">
          Password
        </h2>
        <ChangePasswordForm />
      </section>

      <section id="two-factor" aria-labelledby="two-factor-heading" className="space-y-4">
        <h2 id="two-factor-heading" className="text-lg font-semibold">
          Two-factor authentication
        </h2>
        {error ? (
          <PartError what="your two-factor settings" retryHref="/dashboard/settings/security" />
        ) : (
          <TwoFactorPanel factorId={factorId} />
        )}
      </section>
    </div>
  )
}

export default function SecurityPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Security searchParams={searchParams} />
    </Suspense>
  )
}
