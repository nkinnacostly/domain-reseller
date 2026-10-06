import { CircleAlert, FlaskConical, Lock, PauseCircle } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { AccountBanner } from '../lib/state'

const ICON = {
  sandbox: FlaskConical,
  paused: PauseCircle,
  past_due: CircleAlert,
  closed: Lock,
} as const

const TONE_CLASS = {
  success: 'bg-tone-success text-tone-success-foreground',
  warning: 'bg-tone-warning text-tone-warning-foreground',
  danger: 'bg-tone-danger text-tone-danger-foreground',
  info: 'bg-tone-info text-tone-info-foreground',
  neutral: 'bg-tone-neutral text-tone-neutral-foreground',
} as const

/**
 * The account's state above every dashboard page (MAIL-SPEC §7.2, §8, MR5):
 * a title, an icon and the words — the tint is never the only signal (S8).
 */
export function StateBanner({ banner }: { banner: AccountBanner | null }) {
  if (!banner) return null
  const Icon = ICON[banner.kind]
  return (
    <section
      aria-label="Account status"
      data-banner={banner.kind}
      className={cn('flex gap-3 rounded-2xl px-4 py-3 text-sm/6', TONE_CLASS[banner.tone])}
    >
      <Icon className="mt-1 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 text-pretty">
        <p className="font-semibold">{banner.title}</p>
        <p>
          {banner.body}{' '}
          {banner.kind === 'sandbox' ? (
            <Link
              href="/dashboard#next-steps"
              className="rounded-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              See the next steps
            </Link>
          ) : null}
          {banner.kind === 'past_due' ? (
            <Link
              href="/dashboard/billing"
              className="rounded-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Go to Billing
            </Link>
          ) : null}
        </p>
      </div>
    </section>
  )
}
