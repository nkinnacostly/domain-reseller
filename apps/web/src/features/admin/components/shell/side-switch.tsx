'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { FOCUS } from '@/components/layout/panel'
import { switchAdminSide } from '@/features/admin/actions/side'
import type { AdminSide } from '@/features/admin/lib/side'
import { cn } from '@/lib/utils'

const BUTTON =
  'inline-flex h-11 min-w-20 items-center justify-center rounded-full px-4 text-sm font-medium transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-brand aria-pressed:text-brand-foreground'

/**
 * Live or Test: which records the pages show (ADMIN-SPEC §5.1). Two submit
 * buttons; the pressed one is the side in use, said by `aria-pressed` and
 * by its own words, not by colour alone.
 */
export function SideSwitch({ side, testOnly }: { side: AdminSide; testOnly: boolean }) {
  const router = useRouter()
  const { execute, isPending, result } = useAction(switchAdminSide, {
    onSuccess: () => router.refresh(),
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
        const next = submitter?.value === 'test' ? 'test' : 'live'
        if (next !== side) execute({ side: next })
      }}
      className="flex flex-col items-start gap-1"
    >
      <fieldset className="inline-flex gap-1 rounded-full border border-border bg-background p-1">
        <legend className="sr-only">Records shown</legend>
        {(['live', 'test'] as const).map((value) => (
          <button
            key={value}
            type="submit"
            name="side"
            value={value}
            aria-pressed={side === value}
            disabled={isPending || (testOnly && value === 'live')}
            className={cn(BUTTON, side !== value && 'text-foreground hover:bg-muted', FOCUS)}
          >
            {value === 'live' ? 'Live' : 'Test'}
          </button>
        ))}
      </fieldset>
      {result.serverError ? (
        <p role="alert" className="text-xs text-destructive">
          {result.serverError}
        </p>
      ) : null}
    </form>
  )
}
