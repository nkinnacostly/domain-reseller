import type { Metadata } from 'next'
import { connection } from 'next/server'
import { Suspense } from 'react'
import { AdminGate } from '@/features/admin/components/shell/admin-gate'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminSidebar, AdminSidebarSkeleton } from '@/features/admin/components/shell/admin-sidebar'
import { adminSessionStatus, assertAdminArea } from '@/features/admin/queries/session'
import { PRIVATE } from '@/features/seo/lib/metadata'

/**
 * Never indexed or followed; the proxy also sends an admin X-Robots-Tag, and
 * everyone else the site's plain 404 (D9). A stranger's title names no admin
 * area either, should the proxy ever not run for a path (§2.3).
 */
export async function generateMetadata(): Promise<Metadata> {
  if ((await adminSessionStatus()) === 'not_admin') return { robots: PRIVATE }
  return { robots: PRIVATE, title: { template: '%s · Admin', default: 'Admin' } }
}

/**
 * No static shell: a prerendered shell's scripts carry no nonce, and the
 * admin CSP allows only scripts with this request's nonce (§2.3). So every
 * admin page renders at request time — and may block while it does.
 */
export const instant = false

/**
 * The back office (ADR-006, docs/ADMIN-SPEC.md §2.3): the panel's shell,
 * with every page rendered through AdminGate. The proxy has already asked
 * SQL; the gate and each page ask again.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await connection()
  // Before the sidebar or any admin words: a stranger gets the not-found page.
  await assertAdminArea()
  return (
    <div className="min-h-dvh bg-linear-to-br from-brand-subtle via-background to-brand-subtle">
      <div className="mx-auto flex w-full max-w-[100rem] flex-col lg:flex-row lg:items-start lg:gap-4 lg:p-4">
        <Suspense fallback={<AdminSidebarSkeleton />}>
          <AdminSidebar />
        </Suspense>
        <div className="flex min-w-0 flex-1 flex-col">
          <main id="main" className="min-h-[60dvh] flex-1 pb-6">
            <Suspense fallback={<AdminPageSkeleton />}>
              <AdminGate>{children}</AdminGate>
            </Suspense>
          </main>
        </div>
      </div>
    </div>
  )
}
