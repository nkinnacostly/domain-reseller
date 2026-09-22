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
      description="Enter the email on your account and we'll send you a link to choose a new password. For your security, changes to your domains are paused for 24 hours after a reset."
      footer={
        <Link
          href="/sign-in"
          className="font-medium text-foreground underline-offset-4 hover:underline"
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
