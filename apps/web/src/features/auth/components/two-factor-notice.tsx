import { ArrowRight, ShieldAlert } from 'lucide-react'
import Link from 'next/link'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'
import { TWO_FACTOR_REQUIRED_ABOVE_DOMAINS, TWO_FACTOR_SETTINGS_HREF } from '../lib/security'
import { getTwoFactorRequirement } from '../queries/two-factor'

/**
 * FR-A2: an account holding more than ten domains without two-factor sees
 * this at the top of every panel page until it is on — the same rule
 * placeOrder and placeTransfer enforce, said before anyone reaches Pay.
 * Everyone else sees nothing.
 */
export async function TwoFactorNotice() {
  const requirement = await getTwoFactorRequirement()
  if (!requirement?.required || requirement.hasFactor) return null
  return <TwoFactorRequired held={requirement.held} />
}

export function TwoFactorRequired({ held }: { held: number }) {
  return (
    // The page's own gutter (PanelPage), so the notice lines up with the cards below it.
    <div className="px-4 pt-4 sm:px-6 sm:pt-6 lg:px-0 lg:pt-0 lg:pb-4 print:hidden">
      <section
        aria-labelledby="two-factor-required-title"
        className="flex flex-col gap-4 rounded-3xl border border-status-expiring/60 bg-status-expiring/15 p-5 shadow-xs sm:flex-row sm:items-center sm:p-6"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-status-expiring text-status-expiring-foreground">
            <ShieldAlert className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p id="two-factor-required-title" className="font-medium text-foreground">
              Turn on two-factor authentication
            </p>
            <p className="mt-1 text-pretty text-sm/6 text-foreground">
              Your account holds {held} domains, and accounts holding more than{' '}
              {TWO_FACTOR_REQUIRED_ABOVE_DOMAINS} need two-factor authentication. Until it’s on, you
              can’t order new domains, transfer more in, or make security changes such as
              nameservers and the transfer lock. Renewals carry on as normal.
            </p>
          </div>
        </div>
        <Link
          href={TWO_FACTOR_SETTINGS_HREF}
          className={cn(
            'inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 active:scale-[0.98] sm:w-auto',
            FOCUS,
          )}
        >
          Turn on two-factor
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </section>
    </div>
  )
}
