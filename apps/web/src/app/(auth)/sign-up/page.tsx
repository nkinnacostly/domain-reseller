import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { AuthCard, AuthCardSkeleton } from '@/features/auth/components/auth-card'
import { SignUpForm } from '@/features/auth/components/sign-up-form'

export const metadata: Metadata = { title: 'Create an account' }

type Params = Promise<{ next?: string }>

async function SignUp({ searchParams }: { searchParams: Params }) {
  const { next } = await searchParams
  const signInHref = next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in'
  return (
    <AuthCard
      title="Create an account"
      description="Buy and manage domains, pay in naira, and see every renewal price upfront."
      footer={
        <>
          Already have an account?{' '}
          <Link
            href={signInHref}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
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
