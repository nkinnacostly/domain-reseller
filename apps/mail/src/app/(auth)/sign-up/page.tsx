import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { AuthCard, AuthCardSkeleton } from '@/features/auth/components/auth-card'
import { GoogleSignIn } from '@/features/auth/components/google-sign-in'
import { SignUpForm } from '@/features/auth/components/sign-up-form'
import { googleSignInAvailable } from '@/features/auth/queries/providers'

export const metadata: Metadata = { title: 'Create an account' }

type Params = Promise<{ next?: string }>

/**
 * MAIL-SPEC §7.1: email and password (Turnstile, then email confirmation),
 * or Google. The business details come next, at onboarding.
 */
async function SignUp({ searchParams }: { searchParams: Params }) {
  const { next } = await searchParams
  const google = await googleSignInAvailable()
  const signInHref = next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in'
  return (
    <AuthCard
      title="Create an account"
      description="Send receipts, sign-in links and alerts from your own domain. You start in the sandbox, free."
      footer={
        <>
          Already have an account?{' '}
          <Link
            href={signInHref}
            className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Sign in
          </Link>
        </>
      }
    >
      {google ? <GoogleSignIn next={next} /> : null}
      <SignUpForm next={next} />
    </AuthCard>
  )
}

export default function SignUpPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <SignUp searchParams={searchParams} />
    </Suspense>
  )
}
