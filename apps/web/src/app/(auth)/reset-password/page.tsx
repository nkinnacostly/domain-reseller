import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { AuthCard, AuthCardSkeleton } from '@/features/auth/components/auth-card'
import { ResetPasswordForm } from '@/features/auth/components/recovery-forms'
import { startedFromEmailLink } from '@/features/auth/lib/security'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Choose a new password' }

/** Only reachable with a session (proxy); only useful with one from a reset link. */
async function ResetPassword() {
  const supabase = await createClient()
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()

  if (!startedFromEmailLink(aal?.currentAuthenticationMethods ?? [])) {
    return (
      <AuthCard
        title="Change your password in Settings"
        description="This page is for reset links from your email. You're signed in normally, so change your password from Settings, where we'll ask for your current one."
      >
        <Link
          href="/app/settings"
          className="inline-flex h-11 w-full items-center justify-center rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Go to Settings
        </Link>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Choose a new password"
      description="You'll stay signed in here, and every other device will be signed out. Changes to your domains are paused for 24 hours after a reset, in case this wasn't you."
    >
      <ResetPasswordForm />
    </AuthCard>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <ResetPassword />
    </Suspense>
  )
}
