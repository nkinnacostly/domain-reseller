import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { AuthCard, AuthCardSkeleton } from '@/features/auth/components/auth-card'
import { SignOutButton } from '@/features/auth/components/sign-out-button'
import { VerifyForm } from '@/features/auth/components/verify-form'
import { safeNext } from '@/features/auth/lib/redirect'
import { env } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Two-factor code' }

type Params = Promise<{ next?: string }>

/**
 * The second step of sign-in, and the step-up before turning two-factor off
 * (the shop's FR-A3). With no authenticator enrolled there is nothing to ask.
 */
async function Verify({ searchParams }: { searchParams: Params }) {
  const { next } = await searchParams
  const supabase = await createClient()
  const { data: factors } = await supabase.auth.mfa.listFactors()
  if (!factors?.totp.some((factor) => factor.status === 'verified')) {
    redirect(safeNext(next, env.NEXT_PUBLIC_MAIL_URL))
  }

  return (
    <AuthCard
      title="Enter your two-factor code"
      description="Your sign-in is protected with an authenticator app. Enter the code it shows to continue."
      footer={
        <>
          Lost your phone? Write to hello@mydomainshub.com, or <SignOutButton variant="link" />
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
