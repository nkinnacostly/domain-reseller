import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { AuthCard, AuthCardSkeleton } from '@/features/auth/components/auth-card'
import { SignOutButton } from '@/features/auth/components/sign-out-button'
import { VerifyForm } from '@/features/auth/components/verify-form'
import { safeNext } from '@/features/auth/lib/redirect'
import { NOT_INDEXED, pageMetadata } from '@/features/seo/lib/metadata'
import { env } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = pageMetadata({
  title: 'Two-factor code',
  path: '/verify',
  robots: NOT_INDEXED,
})

type Params = Promise<{ next?: string }>

/**
 * The second step of sign-in, and the step-up before a sensitive change
 * (FR-A3). With no authenticator enrolled there is nothing to ask for.
 */
async function Verify({ searchParams }: { searchParams: Params }) {
  const { next } = await searchParams
  const supabase = await createClient()
  const { data: factors } = await supabase.auth.mfa.listFactors()
  if (!factors?.totp.some((factor) => factor.status === 'verified')) {
    redirect(safeNext(next, env.NEXT_PUBLIC_APP_URL))
  }

  return (
    <AuthCard
      title="Enter your two-factor code"
      description="Your account is protected with an authenticator app. Enter the code it shows to continue."
      footer={
        <>
          Lost your phone? Contact support, or <SignOutButton variant="link" />
        </>
      }
    >
      <VerifyForm next={next} />
    </AuthCard>
  )
}

export default function VerifyPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <Verify searchParams={searchParams} />
    </Suspense>
  )
}
