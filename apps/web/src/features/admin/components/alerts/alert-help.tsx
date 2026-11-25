'use client'

import type { AlertHelp as Help } from '@dr/shared/ai'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { FOCUS } from '@/components/layout/panel'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { askAlertHelp } from '@/features/admin/actions/copilot'
import { COPILOT, copilotButtonLabel, offersTicket } from '@/features/admin/lib/copilot-copy'
import { adminOutcome } from '@/features/admin/lib/errors'
import { cn } from '@/lib/utils'

type Mode = 'explain' | 'ticket'
type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; help: Help }

const SMALL = cn(QUIET_BUTTON, 'h-11 px-4')

/**
 * "Explain" and, where the supplier may be the cause, "Draft supplier
 * ticket" on an open alert (migration 74). Each opening is a new audited
 * request; the answer lives in this dialog only and goes when it closes.
 */
export function AlertHelp({
  alertId,
  kind,
  kindLabel,
  page,
}: {
  alertId: number
  kind: string
  kindLabel: string
  page: string
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <HelpDialog alertId={alertId} kindLabel={kindLabel} page={page} mode="explain" />
      {offersTicket(kind) ? (
        <HelpDialog alertId={alertId} kindLabel={kindLabel} page={page} mode="ticket" />
      ) : null}
    </div>
  )
}

function HelpDialog({
  alertId,
  kindLabel,
  page,
  mode,
}: {
  alertId: number
  kindLabel: string
  page: string
  mode: Mode
}) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<State>({ status: 'idle' })

  async function ask() {
    setState({ status: 'loading' })
    const result = adminOutcome(
      await askAlertHelp({ alertId, mode, page, requestKey: crypto.randomUUID() }),
    )
    if (result.ok && result.data) setState({ status: 'done', help: result.data })
    else setState({ status: 'error', message: result.ok ? COPILOT.retry : result.message })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void ask()
        else setState({ status: 'idle' })
      }}
    >
      <DialogTrigger asChild>
        <button type="button" className={SMALL} aria-label={copilotButtonLabel(mode, kindLabel)}>
          {mode === 'explain' ? COPILOT.explain : COPILOT.ticket}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div className="grid gap-4">
          <DialogTitle className="pr-8 text-lg font-medium">{COPILOT.title[mode]}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {kindLabel}
          </DialogDescription>
          <div aria-live="polite" aria-busy={state.status === 'loading'} className="grid gap-4">
            {state.status === 'loading' || state.status === 'idle' ? (
              <div className="grid gap-2">
                <span className="sr-only">{COPILOT.loading}</span>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : state.status === 'error' ? (
              <div className="grid gap-3">
                <p role="alert" className="text-sm text-foreground">
                  {state.message}
                </p>
                <button type="button" className={cn(SMALL, 'justify-self-start')} onClick={ask}>
                  {COPILOT.retry}
                </button>
              </div>
            ) : (
              <Answer help={state.help} />
            )}
          </div>
          <p className="text-xs text-muted-foreground">{COPILOT.note}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Answer({ help }: { help: Help }) {
  return (
    <div className="grid gap-4 text-sm">
      <p className="text-foreground">{help.explanation}</p>
      {help.steps.length > 0 ? (
        <div>
          <h3 className="font-medium text-foreground">{COPILOT.steps}</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-foreground">
            {help.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {help.ticket ? <Ticket ticket={help.ticket} /> : null}
    </div>
  )
}

function Ticket({ ticket }: { ticket: { subject: string; body: string } }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid gap-2 rounded-xl border border-border p-3">
      <p>
        <span className="text-muted-foreground">{COPILOT.subject}: </span>
        <span className="text-foreground">{ticket.subject}</span>
      </p>
      <div>
        <span className="text-muted-foreground">{COPILOT.body}</span>
        <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-foreground">
          {ticket.body}
        </pre>
      </div>
      <button
        type="button"
        className={cn(SMALL, 'justify-self-start', FOCUS)}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(`${ticket.subject}\n\n${ticket.body}`)
            setCopied(true)
          } catch {
            setCopied(false)
          }
        }}
      >
        {copied ? (
          <Check aria-hidden="true" className="size-4" />
        ) : (
          <Copy aria-hidden="true" className="size-4" />
        )}
        {copied ? COPILOT.copied : COPILOT.copy}
      </button>
    </div>
  )
}
