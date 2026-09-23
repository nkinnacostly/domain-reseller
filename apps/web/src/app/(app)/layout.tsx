import { Suspense } from 'react'
import { AppHeader, AppHeaderSkeleton } from '@/components/layout/app-header'
import { SiteFooter } from '@/components/layout/site-footer'

/** The signed-in panel (PRD §14, /app/*). The proxy has already checked the session. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={<AppHeaderSkeleton />}>
        <AppHeader />
      </Suspense>
      <main id="main" className="min-h-[60dvh]">
        {children}
      </main>
      {/* Its links read the path, which on /app/domains/[domain] is request
          data — so it streams in rather than blocking the prerender. */}
      <Suspense fallback={null}>
        <SiteFooter />
      </Suspense>
    </>
  )
}
