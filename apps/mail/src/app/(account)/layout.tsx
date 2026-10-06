import Link from 'next/link'
import { Brand, PRODUCT_NAME } from '@/components/layout/brand'
import { Container } from '@/components/layout/container'
import { SiteFooter } from '@/components/layout/site-footer'
import { ThemeToggle } from '@/components/layout/theme-toggle'
import { SignOutButton } from '@/features/auth/components/sign-out-button'

/**
 * Onboarding and the invite page: signed in, but not in an account's
 * dashboard yet. The brand, a way out, and one task.
 */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-background">
        <Container className="flex h-16 items-center justify-between gap-3">
          <Link
            href="/"
            aria-label={`${PRODUCT_NAME}, home`}
            className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <Brand compact />
          </Link>
          <div className="flex items-center gap-1">
            <SignOutButton className="min-h-11" />
            <ThemeToggle />
          </div>
        </Container>
      </header>
      <main id="main" className="flex-1">
        <Container className="py-8 sm:py-12">{children}</Container>
      </main>
      <SiteFooter />
    </div>
  )
}
