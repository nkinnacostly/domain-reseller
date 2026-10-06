import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { AuthCard, AuthCardSkeleton } from '@/features/auth/components/auth-card'
import { ForgotPasswordForm } from '@/features/auth/components/recovery-forms'

export const metadata: Metadata = { title: 'Reset your password' }

type Params = Promise<{ error?: string }>

async function ForgotPassword({ searchParams }: { searchParams: Params }) {
  const { error } = await searchParams
  return (
    <AuthCard
      title="Reset your password"
      description="We'll email you a link to choose a new one. It is the password for your MyDomainsHub sign-in, used by Mail and the domain shop."
      footer={
        <Link
          href="/sign-in"
          className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Back to sign in
        </Link>
      }
    >
      <ForgotPasswordForm error={error} />
    </AuthCard>
  )
}

export default function ForgotPasswordPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <ForgotPassword searchParams={searchParams} />
    </Suspense>
  )
}
