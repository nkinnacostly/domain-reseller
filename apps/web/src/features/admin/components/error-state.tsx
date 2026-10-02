'use client'

import { RotateCw, TriangleAlert } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { PANEL } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/**
 * A read that failed: what happened and a way on (S11). "Try again" asks the
 * server for the page again; an error boundary passes its own `retry`.
 */
export function ErrorState({
  title = "This couldn't be loaded.",
  body = 'Nothing was changed. Try again; if it keeps failing, the health page says what is down.',
  retry,
  className,
}: {
  title?: string
  body?: string
  retry?: () => void
  className?: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <div role="alert" className={cn(PANEL, 'flex flex-col items-start gap-3 p-6', className)}>
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
        <div>
          <p className="font-medium text-foreground">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{body}</p>
        </div>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(() => {
            if (retry) retry()
            else router.refresh()
          })
        }
        className={QUIET_BUTTON}
      >
        <RotateCw className={cn('size-4', pending && 'animate-spin')} aria-hidden="true" />
        Try again
      </button>
    </div>
  )
}
