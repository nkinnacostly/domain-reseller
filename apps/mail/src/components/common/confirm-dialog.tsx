'use client'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { Spinner } from '../ui/spinner'
import { FormMessage } from './form-parts'

/** The look of a button that takes something away: outlined in the danger tone, never colour alone. */
export const dangerButtonClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-tone-danger-foreground/40 bg-background px-5 text-sm font-medium text-tone-danger-foreground transition hover:bg-tone-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60'

/**
 * Asks before something that cannot be undone from here — removing a member,
 * leaving an account, handing it over (S12: pressed and pending states; a
 * second press while it runs does nothing). The dialog stays open until the
 * action answers, and shows its refusal in place.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  confirmLabel,
  pendingLabel,
  pending,
  error,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The button that opens it; leave out to open it from code (`open`). */
  trigger?: React.ReactNode
  title: string
  description: React.ReactNode
  confirmLabel: string
  pendingLabel: string
  pending: boolean
  error?: string | null
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-pretty">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} className="min-h-11 rounded-full">
            Cancel
          </AlertDialogCancel>
          <button
            type="button"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={onConfirm}
            className={cn(dangerButtonClass)}
          >
            {pending ? (
              <>
                <Spinner className="size-4" aria-hidden="true" />
                {pendingLabel}
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
