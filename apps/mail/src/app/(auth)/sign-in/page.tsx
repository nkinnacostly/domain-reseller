import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { AuthCard, AuthCardSkeleton } from '@/features/auth/components/auth-card'
import { GoogleSignIn } from '@/features/auth/components/google-sign-in'
import { SignInForm } from '@/features/auth/components/sign-in-form'
import { googleSignInAvailable } from '@/features/auth/queries/providers'

export const metadata: Metadata = { title: 'Sign in' }

type Params = Promise<{ next?: string; notice?: string; error?: string }>

/** MAIL-SPEC §7.1: email and password, or Google when Supabase has it on. */
async function SignIn({ searchParams }: { searchParams: Params }) {
  const { next, notice, error } = await searchParams
  const google = await googleSignInAvailable()
  const signUpHref = next ? `/sign-up?next=${encodeURIComponent(next)}` : '/sign-up'
  return (
    <AuthCard
      title="Sign in"
      description="To MyDomainsHub Mail. Your MyDomainsHub domain shop sign-in works here too."
      footer={
        <>
          New here?{' '}
          <Link
            href={signUpHref}
            className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Create an account
          </Link>
        </>
      }
    >
      {google ? <GoogleSignIn next={next} failed={error === 'oauth'} /> : null}
      <SignInForm next={next} notice={notice ?? error} />
    </AuthCard>
  )
}

export default function SignInPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <SignIn searchParams={searchParams} />
    </Suspense>
  )
}
