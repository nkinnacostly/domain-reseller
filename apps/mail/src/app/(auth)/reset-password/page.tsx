import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { AuthCard, AuthCardSkeleton } from '@/features/auth/components/auth-card'
import { ResetPasswordForm } from '@/features/auth/components/recovery-forms'
import { SECURITY_PAGE } from '@/features/auth/lib/links'
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
        title="Change your password under Your security"
        description="This page is for reset links from your email. You're signed in normally, so change your password under Your security, where we'll ask for your current one."
      >
        <Link
          href={SECURITY_PAGE}
          className="inline-flex h-11 w-full items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
        >
          Go to Your security
        </Link>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Choose a new password"
      description="It signs you in to Mail and the MyDomainsHub domain shop. You'll stay signed in here and every other device will be signed out. Two-factor changes, and changes to any domains you hold with us, are paused for 24 hours, in case this wasn't you."
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
