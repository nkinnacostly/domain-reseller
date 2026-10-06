import type { Metadata } from 'next'
import { connection } from 'next/server'
import { Suspense } from 'react'
import { PageSkeleton } from '@/features/admin/components/parts'
import { AdminFrame } from '@/features/admin/components/shell/admin-frame'
import { AdminGate } from '@/features/admin/components/shell/admin-gate'
import { ROLE_LABEL } from '@/features/admin/lib/actions'
import { adminSessionStatus, assertAdminArea, findAdmin } from '@/features/admin/queries/session'

/**
 * Never indexed or followed; the proxy also sends an admin X-Robots-Tag, and
 * everyone else Mail's plain 404 (D9). A stranger's title names no admin
 * area either, should the proxy ever not run for a path.
 */
export async function generateMetadata(): Promise<Metadata> {
  const robots = { index: false, follow: false }
  if ((await adminSessionStatus()) === 'not_admin') return { robots }
  return { robots, title: { template: '%s · Mail admin', default: 'Mail admin' } }
}

/**
 * No static shell: a prerendered shell's scripts carry no nonce, and the
 * admin CSP allows only scripts with this request's nonce. So every admin
 * page renders at request time.
 */
export const instant = false

/**
 * Mail's back office (MAIL-SPEC §10, M5: the shop's admins and gate,
 * ADR-006). The proxy has already asked SQL; this layout, the gate and each
 * read ask again.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await connection()
  // Before any admin words: a stranger gets the not-found page.
  const status = await assertAdminArea()
  const admin = status === 'ok' ? await findAdmin() : null
  return (
    <AdminFrame roleLabel={admin ? ROLE_LABEL[admin.role] : null} showNav={admin !== null}>
      <Suspense fallback={<PageSkeleton />}>
        <AdminGate>{children}</AdminGate>
      </Suspense>
    </AdminFrame>
  )
}
