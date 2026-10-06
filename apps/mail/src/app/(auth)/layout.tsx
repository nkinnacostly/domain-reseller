import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { Brand, PRODUCT_NAME } from '@/components/layout/brand'
import { Container } from '@/components/layout/container'
import { SiteFooter } from '@/components/layout/site-footer'
import { ThemeToggle } from '@/components/layout/theme-toggle'

/**
 * Sign-in, sign-up and recovery (MAIL-SPEC §7.1): the brand, a way back, and
 * one form — nothing to wander off into.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
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
            <Link
              href="/"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring active:scale-[0.98]"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              Home
            </Link>
            <ThemeToggle />
          </div>
        </Container>
      </header>
      <main id="main" className="flex flex-1 items-start sm:items-center">
        <Container className="py-8 sm:py-14">{children}</Container>
      </main>
      <SiteFooter />
    </div>
  )
}
