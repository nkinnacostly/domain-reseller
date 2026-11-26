'use client'

import { ArrowUp, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { inputClass, onSubmitWith } from '@/components/common/form-parts'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { askAssistant } from '../actions/ask-assistant'
import {
  ASSISTANT_STARTERS,
  type AskAssistantResult,
  historyOf,
  MESSAGE_MAX,
  MESSAGE_MIN,
  type Turn,
} from '../lib/conversation'
import { AssistantReplyView } from './assistant-reply'

type Entry =
  | { id: number; role: 'person'; text: string }
  | { id: number; role: 'assistant'; result: AskAssistantResult }

/** Each earlier entry as the server takes it: the person's words, or the reply's memo. */
function turnsOf(entries: readonly Entry[]): Turn[] {
  return entries.flatMap((entry): Turn[] => {
    if (entry.role === 'person') return [{ role: 'person', text: entry.text }]
    return entry.result.ok ? [{ role: 'assistant', text: entry.result.memo }] : []
  })
}

/**
 * The conversation (AI phase 5). It lives only in this page's memory: nothing
 * is stored, and leaving the site forgets it. The sheet stays mounted while
 * closed, so closing and reopening keeps the thread.
 */
export function AssistantSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const id = useId()
  const [entries, setEntries] = useState<Entry[]>([])
  const [error, setError] = useState<string | undefined>()
  const [pending, startTransition] = useTransition()
  const nextId = useRef(0)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Newest at the bottom, in view — "smooth" only when motion is welcome (S9).
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each new entry and on the pending row
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    endRef.current?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'end' })
  }, [entries.length, pending])

  const send = (raw: string) => {
    const message = raw.trim()
    if (message.length < MESSAGE_MIN) {
      setError('Type a few words first.')
      return
    }
    if (pending) return
    setError(undefined)
    const history = historyOf(turnsOf(entries))
    const person: Entry = { id: nextId.current++, role: 'person', text: message }
    setEntries((current) => [...current, person])
    if (inputRef.current) inputRef.current.value = ''
    startTransition(async () => {
      const answer = await askAssistant({ message, history })
      const result: AskAssistantResult = answer?.data ?? { ok: false, reason: 'unavailable' }
      setEntries((current) => [...current, { id: nextId.current++, role: 'assistant', result }])
    })
  }

  const submit = onSubmitWith((form) => send(String(form.get('message') ?? '')))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full gap-0 p-0 sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <SheetHeader className="flex-row items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <SheetTitle>Ask MyDomainsHub</SheetTitle>
            <SheetDescription>
              Find a name, check one, see prices, or get help pointing your domain.
            </SheetDescription>
          </div>
          <SheetClose className="-mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-95">
            <X className="size-5" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </SheetClose>
        </SheetHeader>

        <div
          role="log"
          aria-label="Conversation"
          aria-live="polite"
          aria-busy={pending || undefined}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4"
        >
          {entries.length === 0 ? (
            <div>
              <p className="text-sm text-muted-foreground">Try one of these, or ask your own:</p>
              <ul className="mt-3 flex flex-col gap-2">
                {ASSISTANT_STARTERS.map((starter) => (
                  <li key={starter}>
                    <button
                      type="button"
                      onClick={() => send(starter)}
                      disabled={pending}
                      className="min-h-11 w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-left text-sm text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {starter}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            entries.map((entry) =>
              entry.role === 'person' ? (
                <div key={entry.id} className="flex justify-end">
                  <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm/6 text-pretty break-words text-accent-foreground">
                    <span className="sr-only">You: </span>
                    {entry.text}
                  </p>
                </div>
              ) : (
                <div key={entry.id} className="min-w-0">
                  <span className="sr-only">MyDomainsHub: </span>
                  <AssistantReplyView result={entry.result} />
                </div>
              ),
            )
          )}
          {pending ? (
            <div aria-hidden="true" className="space-y-2">
              <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          ) : null}
          <div ref={endRef} />
        </div>

        <form
          onSubmit={submit}
          aria-label="Message the assistant"
          noValidate
          className="border-t border-border px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        >
          <label htmlFor={`${id}-message`} className="sr-only">
            Your message
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              id={`${id}-message`}
              name="message"
              autoComplete="off"
              maxLength={MESSAGE_MAX}
              placeholder="Ask about names, prices or setup"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : `${id}-hint`}
              className={cn(inputClass, 'min-w-0 flex-1')}
            />
            <button
              type="submit"
              disabled={pending}
              aria-busy={pending || undefined}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-95 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {pending ? (
                <Spinner className="size-4" aria-hidden="true" />
              ) : (
                <ArrowUp className="size-5" aria-hidden="true" />
              )}
              <span className="sr-only">{pending ? 'Sending…' : 'Send'}</span>
            </button>
          </div>
          {error ? (
            <p id={`${id}-error`} className="mt-2 text-sm text-destructive">
              {error}
            </p>
          ) : (
            <p id={`${id}-hint`} className="mt-2 text-xs text-muted-foreground">
              AI by DeepSeek, answering from our own pages, prices and live checks. What you type is
              sent with email addresses and phone numbers taken out; leave out anything personal.
            </p>
          )}
        </form>
      </SheetContent>
    </Sheet>
  )
}
