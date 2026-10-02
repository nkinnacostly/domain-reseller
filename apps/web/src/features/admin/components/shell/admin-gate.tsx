import { ShieldAlert } from 'lucide-react'
import { notFound } from 'next/navigation'
import { Panel, PanelPage } from '@/components/layout/panel'
import { adminSessionStatus, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { SideBanner } from './side-banner'
import { SignOutButton } from './sign-out-button'

export const FACTOR_MISMATCH_WORDS =
  "This sign-in used an authenticator that isn't linked to your admin access. Use a linked device, or ask the owner to re-link your devices in the database (DEPLOY.md §6b)."
export const WEAK_SIGN_IN_WORDS =
  'The admin area needs a sign-in with your password or Google. Sign out, sign in again, then enter your code.'

/**
 * The gate every admin page renders through (ADMIN-SPEC §2.3). SQL decides
 * (`admin_status`); two refusals are explained, because only an admin can
 * meet them, and anything else is a 404 — nothing tells a stranger the
 * admin area exists.
 */
export async function AdminGate({ children }: { children: React.ReactNode }) {
  const status = await adminSessionStatus()
  if (status === 'ok') {
    const admin = await requireAdmin()
    const side = await getAdminSide(admin)
    return (
      <>
        <SideBanner admin={admin} side={side} />
        {children}
      </>
    )
  }
  if (status === 'factor_mismatch') return <GateMessage words={FACTOR_MISMATCH_WORDS} />
  if (status === 'weak_sign_in') {
    return (
      <GateMessage words={WEAK_SIGN_IN_WORDS}>
        <SignOutButton />
      </GateMessage>
    )
  }
  notFound()
}

function GateMessage({ words, children }: { words: string; children?: React.ReactNode }) {
  return (
    <PanelPage>
      <Panel labelledBy="admin-gate-heading">
        <div className="flex items-start gap-3">
          <ShieldAlert
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="space-y-4">
            <h1 id="admin-gate-heading" className="text-xl font-medium text-foreground">
              The admin area can't open with this sign-in
            </h1>
            <p className="max-w-xl text-sm/6 text-muted-foreground">{words}</p>
            {children}
          </div>
        </div>
      </Panel>
    </PanelPage>
  )
}
