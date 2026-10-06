import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Container } from '@/components/layout/container'
import { Skeleton } from '@/components/ui/skeleton'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Dashboard' }

/**
 * The signed-in area's first page (MAIL-SPEC §10). The proxy sends anyone
 * signed out to /sign-in; the overview, the log and the rest arrive with the
 * packages that build them.
 */
export default function DashboardPage() {
  return (
    <Container className="py-8 sm:py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
      <Suspense fallback={<Skeleton className="mt-4 h-6 w-64" />}>
        <SignedInAs />
      </Suspense>
      <section
        aria-labelledby="accounts-heading"
        className="mt-8 rounded-3xl border border-brand-subtle-border bg-card p-6 sm:p-8"
      >
        <h2 id="accounts-heading" className="font-medium">
          Your Mail accounts
        </h2>
        <p className="mt-2 max-w-xl text-sm/6 text-muted-foreground">
          Accounts, domains, API keys and the email log will show here. They are not built yet.
        </p>
      </section>
    </Container>
  )
}

async function SignedInAs() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return (
    <p className="mt-2 text-sm text-muted-foreground">
      {user?.email ? `Signed in as ${user.email}.` : 'Signed in.'}
    </p>
  )
}
