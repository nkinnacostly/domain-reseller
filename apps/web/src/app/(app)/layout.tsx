import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { AppSidebar, AppSidebarSkeleton } from '@/components/layout/app-sidebar'
import { TwoFactorNotice } from '@/features/auth/components/two-factor-notice'
import { PRIVATE } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

/** Behind sign-in: nothing here to index or follow (robots.txt also closes /app/). */
export const metadata: Metadata = { robots: PRIVATE }

/**
 * The signed-in panel (PRD §15.1, /app/*): a sidebar and the page, on the
 * brand's pale blue. The proxy has already checked the session.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-linear-to-br from-brand-subtle via-background to-brand-subtle print:min-h-0 print:bg-none">
      <div className="mx-auto flex w-full max-w-[100rem] flex-col lg:flex-row lg:items-start lg:gap-4 lg:p-4">
        <Suspense fallback={<AppSidebarSkeleton />}>
          <AppSidebar />
        </Suspense>
        <div className="flex min-w-0 flex-1 flex-col">
          <main id="main" className="min-h-[60dvh] flex-1">
            {/* FR-A2: on every page, for an account that must turn two-factor on. */}
            <Suspense fallback={null}>
              <TwoFactorNotice />
            </Suspense>
            {children}
          </main>
          <footer className="px-5 py-6 text-xs text-muted-foreground sm:px-6 lg:px-2 lg:pb-2 print:hidden">
            <p className="flex flex-wrap gap-x-4 gap-y-1">
              <span>
                {BUSINESS.brand} is operated by {BUSINESS.operator}.
              </span>
              <Link
                href="/legal"
                className="underline-offset-4 hover:text-foreground hover:underline"
              >
                Legal
              </Link>
              <Link
                href="/legal/privacy"
                className="underline-offset-4 hover:text-foreground hover:underline"
              >
                Privacy
              </Link>
            </p>
          </footer>
        </div>
      </div>
    </div>
  )
}
