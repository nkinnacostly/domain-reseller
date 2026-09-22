import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { AuthCard, AuthCardSkeleton } from '@/features/auth/components/auth-card'
import { SignInForm } from '@/features/auth/components/sign-in-form'

export const metadata: Metadata = { title: 'Sign in' }

type Params = Promise<{ next?: string; notice?: string; error?: string }>

async function SignIn({ searchParams }: { searchParams: Params }) {
  const { next, notice, error } = await searchParams
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
