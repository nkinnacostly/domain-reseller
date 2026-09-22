import { Suspense } from 'react'
import { AppHeader, AppHeaderSkeleton } from '@/components/layout/app-header'
import { SiteShell } from '@/components/layout/site-shell'

/** The signed-in panel (PRD §14, /app/*). The proxy has already checked the session. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SiteShell>
      <Suspense fallback={<AppHeaderSkeleton />}>
        <AppHeader />
      </Suspense>
      <main id="main" className="min-h-[60dvh]">
        {children}
      </main>
    </SiteShell>
  )
}
