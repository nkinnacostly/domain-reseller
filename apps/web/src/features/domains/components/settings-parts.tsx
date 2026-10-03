'use client'

import { ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/**
 * The shared pieces of the Security and Contacts tabs' controls (SEC-2).
 * ActionError, useOutcome and QUIET_BUTTON moved to
 * components/common/action-parts.tsx when the admin dashboard became their
 * second consumer.
 */

/** A sensitive change without two-factor on the account: say why, and where to turn it on. */
export function NeedsTwoFactor({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border p-4">
      <p className="flex items-start gap-2.5 text-pretty text-sm/6 text-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <span>{children}</span>
      </p>
      <Link
        href="/app/settings#two-factor"
        className={cn(
          'mt-3 inline-flex h-11 items-center rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 active:scale-[0.98]',
          FOCUS,
        )}
      >
        Turn on two-factor
      </Link>
    </div>
  )
}

/** One setting's switch row: the whole label is the target (S7), with its state beneath. */
export const SWITCH_ROW = 'flex min-h-11 cursor-pointer items-start gap-3 text-sm'
