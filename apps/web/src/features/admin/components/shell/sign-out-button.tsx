'use client'

import { LogOut } from 'lucide-react'
import { useAction } from 'next-safe-action/hooks'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { signOut } from '@/features/auth/actions/session'

/** Signs out, so a strong sign-in can start again (AdminGate, weak sign-in). */
export function SignOutButton() {
  const leave = useAction(signOut)
  return (
    <button
      type="button"
      onClick={() => leave.execute()}
      disabled={leave.isPending}
      className={QUIET_BUTTON}
    >
      <LogOut className="size-4" aria-hidden="true" />
      {leave.isPending ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
