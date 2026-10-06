import type { Metadata } from 'next'
import { Container } from '@/components/layout/container'

export const metadata: Metadata = { title: 'Sign in' }

/**
 * Where the proxy sends a signed-out visitor to /dashboard. Sign-in and
 * sign-up (MAIL-SPEC §7.1) come with the accounts package; until then this
 * page says so, and offers nothing that does not work (N9b).
 */
export default function SignInPage() {
  return (
    <Container className="py-12 sm:py-20">
      <div className="mx-auto max-w-md rounded-3xl border border-brand-subtle-border bg-card p-6 sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-3 text-sm/6 text-muted-foreground">
          Signing in to MyDomainsHub Mail is not open yet. It opens with sign-up, before launch.
        </p>
      </div>
    </Container>
  )
}
