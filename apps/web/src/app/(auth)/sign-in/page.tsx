import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { AuthCard, AuthCardSkeleton } from '@/features/auth/components/auth-card'
import { GoogleSignIn } from '@/features/auth/components/google-sign-in'
import { SignInForm } from '@/features/auth/components/sign-in-form'
import { googleSignInAvailable } from '@/features/auth/queries/providers'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Sign in',
  path: '/sign-in',
})

type Params = Promise<{ next?: string; notice?: string; error?: string }>

async function SignIn({ searchParams }: { searchParams: Params }) {
  const { next, notice, error } = await searchParams
  const google = await googleSignInAvailable()
  const signUpHref = next ? `/sign-up?next=${encodeURIComponent(next)}` : '/sign-up'
  return (
    <AuthCard
      title="Sign in"
      description="Manage your domains, renewals and nameservers."
      footer={
        <>
          New here?{' '}
          <Link
            href={signUpHref}
            className="font-medium text-foreground underline-offset-4 hover:underline"
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
