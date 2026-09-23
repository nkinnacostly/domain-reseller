import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { BRAND_NAME, Brand } from '@/components/layout/brand'
import { Container, SiteShell } from '@/components/layout/site-shell'

/** Auth pages: the brand, a way back, and the form. Nothing to wander off into. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <SiteShell>
      <div className="flex min-h-[calc(100dvh-4rem)] flex-col bg-gradient-to-br from-hero-from to-hero-to">
        <header>
          <Container className="flex items-center justify-between gap-4 py-5 sm:py-6">
            <Link href="/" aria-label={`${BRAND_NAME} home`}>
              <Brand />
            </Link>
            <Link
              href="/"
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              {/* The full label wraps beside the wordmark on a phone. */}
              <span className="sm:hidden">Home</span>
              <span className="hidden sm:inline">Back to site</span>
            </Link>
          </Container>
        </header>
        <main id="main" className="flex flex-1 items-start sm:items-center">
          <Container className="w-full py-8 sm:py-14">{children}</Container>
        </main>
      </div>
    </SiteShell>
  )
}
