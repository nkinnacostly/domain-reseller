import { FlaskConical, ShieldAlert } from 'lucide-react'
import { notFound } from 'next/navigation'
import { adminSessionStatus, requireAdmin } from '@/features/admin/queries/session'
import { SignOutButton } from '@/features/auth/components/sign-out-button'
import { AdminPage } from '../parts'

export const FACTOR_MISMATCH_WORDS =
  "This sign-in used an authenticator that isn't linked to your admin access. Use a linked device, or ask the owner to re-link your devices in the database."
export const WEAK_SIGN_IN_WORDS =
  'The admin area needs a sign-in with your password or Google. Sign out, sign in again, then enter your code.'
export const TEST_ADMIN_BANNER =
  'Test administrator: only test accounts are shown, live actions are refused, and resume and cap overrides are not yours.'

/**
 * The gate every admin page renders through (the shop's ADMIN-SPEC §2.3).
 * SQL decides (`admin_status`); two refusals are explained, because only an
 * admin can meet them, and anything else is a 404 — nothing tells a stranger
 * the admin area exists.
 */
export async function AdminGate({ children }: { children: React.ReactNode }) {
  const status = await adminSessionStatus()
  if (status === 'ok') {
    const admin = await requireAdmin()
    return (
      <>
        {admin.testOnly ? (
          <div
            role="note"
            className="mx-5 mt-6 flex items-start gap-2.5 rounded-2xl bg-tone-warning px-4 py-3 text-sm text-tone-warning-foreground sm:mx-8 lg:mx-10"
          >
            <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>{TEST_ADMIN_BANNER}</p>
          </div>
        ) : null}
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
    <AdminPage title="The admin area can't open with this sign-in" icon={ShieldAlert}>
      <p className="max-w-xl text-sm/6 text-muted-foreground">{words}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </AdminPage>
  )
}
