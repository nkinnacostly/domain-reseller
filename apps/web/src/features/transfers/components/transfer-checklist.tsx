import { Check, CircleHelp, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CheckState, TransferCheck } from '../lib/eligibility'

/**
 * Each state has its own icon *and* its own words, so nothing relies on
 * colour alone (S8, WCAG 1.4.1).
 */
const STATE: Record<CheckState, { label: string; icon: typeof Check; tone: string }> = {
  pass: { label: 'Done', icon: Check, tone: 'bg-accent text-accent-foreground' },
  fail: { label: 'Blocked', icon: X, tone: 'bg-destructive text-destructive-foreground' },
  manual: {
    label: 'Check yourself',
    icon: CircleHelp,
    tone: 'bg-muted text-muted-foreground ring-1 ring-border',
  },
}

export function TransferChecklist({ checks }: { checks: TransferCheck[] }) {
  return (
    <ul aria-label="Transfer checklist" className="divide-y divide-border/70">
      {checks.map((check) => {
        const state = STATE[check.state]
        const Icon = state.icon
        return (
          <li key={check.id} data-state={check.state} className="flex gap-4 py-4 first:pt-0">
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full',
                state.tone,
              )}
            >
              <Icon className="size-3.5" strokeWidth={3} />
            </span>
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {check.title}
                <span
                  className={cn(
                    'ml-2 inline-block rounded-full px-2 py-0.5 align-middle text-[0.6875rem] font-medium',
                    // Foreground text on a tint: coloured text on its own tint
                    // falls short of 4.5:1 at this size.
                    check.state === 'fail'
                      ? 'bg-destructive/10 text-foreground'
                      : check.state === 'pass'
                        ? 'bg-accent/10 text-accent'
                        : 'bg-muted text-foreground',
                  )}
                >
                  {state.label}
                </span>
              </p>
              <p className="mt-1 text-pretty text-sm/6 text-muted-foreground">{check.detail}</p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
