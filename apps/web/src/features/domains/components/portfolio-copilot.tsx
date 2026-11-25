'use client'

import { Sparkle } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useId, useState, useTransition } from 'react'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { domainLabel } from '@/components/common/domain-name'
import { FormMessage } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import {
  type BulkResult,
  changeNameserversInBulk,
  lockTransfersInBulk,
  setAutoRenewInBulk,
  setPrivacyInBulk,
  unlockTransfersInBulk,
} from '../actions/bulk'
import { type CopilotResult, draftPortfolioChange } from '../actions/copilot'
import type { CopilotDraft } from '../lib/copilot'
import { PANEL } from './dashboard/panel'

const REFUSAL: Record<Exclude<CopilotResult, { ok: true }>['reason'], string> = {
  off: 'The copilot isn’t switched on yet.',
  limited: 'You’ve asked a lot in a few minutes. Wait a little, then try again.',
  unavailable:
    'The copilot couldn’t answer just now. You can still tick domains below and act on them.',
}
const SHOWN = 8
const PRIMARY = cn(
  'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70',
  FOCUS,
)

type Draft = Extract<CopilotDraft, { kind: 'draft' }>

/**
 * Feature 7 — the portfolio copilot. Someone types what they want done; the
 * copilot drafts it, and nothing changes until they confirm. Confirming runs
 * the same bulk actions as ticking domains below, so the same checks, the
 * second factor and the results page all apply.
 */
export function PortfolioCopilot({ returnTo }: { returnTo: string }) {
  const id = useId()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<CopilotResult | null>(null)

  const ask = (form: HTMLFormElement) => {
    const instruction = String(new FormData(form).get('instruction') ?? '').trim()
    if (instruction.length < 5) return
    startTransition(async () => {
      const answer = await draftPortfolioChange({ instruction })
      setResult(answer?.data ?? { ok: false, reason: 'unavailable' })
    })
  }

  return (
    <section aria-labelledby={`${id}-heading`} className={cn(PANEL, 'p-4 sm:p-5')}>
      <h2 id={`${id}-heading`} className="flex items-center gap-2 font-medium text-foreground">
        <Sparkle className="size-4 text-brand-ink" aria-hidden="true" />
        Tell the copilot what to do
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        For example “point everything labelled Clients at Vercel” or “renew what expires in the next
        60 days”. It drafts the change; nothing happens until you confirm.
      </p>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          ask(event.currentTarget)
        }}
      >
        <label htmlFor={`${id}-instruction`} className="sr-only">
          What should happen to your domains?
        </label>
        <input
          id={`${id}-instruction`}
          name="instruction"
          type="text"
          minLength={5}
          maxLength={500}
          required
          autoComplete="off"
          placeholder="What should happen to your domains?"
          className="h-11 min-w-0 flex-1 rounded-full border border-input bg-background px-4 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending || undefined}
          className={PRIMARY}
        >
          {pending ? <Spinner className="size-4" aria-hidden="true" /> : null}
          {pending ? 'Drafting…' : 'Draft it'}
        </button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">
        Sent to DeepSeek, an AI provider: your words, with domain names, email addresses and phone
        numbers taken out. Your domains are picked here, not by the AI.
      </p>

      <div aria-live="polite" className="mt-3">
        {pending ? (
          <div aria-hidden="true" className="h-24 animate-pulse rounded-2xl bg-muted/70" />
        ) : result && !result.ok ? (
          <FormMessage tone="error">{REFUSAL[result.reason]}</FormMessage>
        ) : result?.ok ? (
          <DraftView draft={result.draft} returnTo={returnTo} onCancel={() => setResult(null)} />
        ) : null}
      </div>
    </section>
  )
}

function DraftView({
  draft,
  returnTo,
  onCancel,
}: {
  draft: CopilotDraft
  returnTo: string
  onCancel: () => void
}) {
  if (draft.kind === 'question') {
    return (
      <p className="rounded-2xl border border-border bg-background px-4 py-3 text-sm">
        {draft.question}
      </p>
    )
  }
  if (draft.kind === 'refused') return <FormMessage tone="error">{draft.reason}</FormMessage>
  const more = draft.domains.length - SHOWN
  return (
    <div className="rounded-2xl border border-border bg-background px-4 py-3.5 text-sm/6">
      <p className="font-medium text-foreground">{draft.summary}</p>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        {draft.domains.slice(0, SHOWN).map((domain) => (
          <li key={domain.id} className="break-all">
            {domainLabel(domain.name)}
          </li>
        ))}
        {more > 0 ? <li>and {more} more</li> : null}
      </ul>
      {draft.notFound.length > 0 ? (
        <p className="mt-2 text-muted-foreground">
          Not on your account, so left out: {draft.notFound.join(', ')}.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {draft.action === 'renew' && draft.renewHref ? (
          <Link href={draft.renewHref} className={PRIMARY}>
            Review the renewal
          </Link>
        ) : (
          <Confirm draft={draft} returnTo={returnTo} />
        )}
        <button type="button" onClick={onCancel} className={QUIET_BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  )
}

type Answer = { data?: BulkResult; serverError?: string; validationErrors?: unknown } | undefined

function run(draft: Draft): Promise<Answer> {
  const domainIds = draft.domains.map((domain) => domain.id)
  switch (draft.action) {
    case 'nameservers':
      return changeNameserversInBulk({
        domainIds,
        nameservers: (draft.nameservers ?? []).join('\n'),
        presetId: draft.presetId,
      })
    case 'auto_renew':
      return setAutoRenewInBulk({ domainIds, enabled: draft.on === true })
    case 'privacy':
      return setPrivacyInBulk({ domainIds, enabled: draft.on === true })
    case 'transfer_lock':
      return draft.on ? lockTransfersInBulk({ domainIds }) : unlockTransfersInBulk({ domainIds })
    default:
      return Promise.resolve(undefined)
  }
}

/** Confirming runs the bulk action itself: its checks, its second factor and its results page. */
function Confirm({ draft, returnTo }: { draft: Draft; returnTo: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [problem, setProblem] = useState<{ message: string; details?: string[] } | null>(null)
  const [warned, setWarned] = useState<{ operationId: string; warnings: string[] } | null>(null)

  const confirm = () =>
    startTransition(async () => {
      setProblem(null)
      const answer = await run(draft)
      if (answer?.serverError) return setProblem({ message: answer.serverError })
      const data = answer?.data
      if (!data) return setProblem({ message: 'That did not go through. Please try again.' })
      if ('error' in data) return setProblem({ message: data.error, details: data.details })
      if (data.warnings.length > 0) return setWarned(data)
      router.push(`/app/domains/bulk/${data.operationId}`)
    })

  if (warned) {
    return (
      <div className="w-full space-y-2">
        <FormMessage tone="success">
          <p>Started. Read these first:</p>
          <ul className="mt-1 list-disc pl-5">
            {warned.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </FormMessage>
        <Link href={`/app/domains/bulk/${warned.operationId}`} className={QUIET_BUTTON}>
          See each domain’s result
        </Link>
      </div>
    )
  }
  return (
    <>
      <button
        type="button"
        onClick={confirm}
        disabled={pending}
        aria-busy={pending || undefined}
        className={PRIMARY}
      >
        {pending ? <Spinner className="size-4" aria-hidden="true" /> : null}
        {pending ? 'Starting…' : `Confirm for ${draft.domains.length}`}
      </button>
      {problem ? (
        <div className="w-full">
          {problem.details?.length ? (
            <FormMessage tone="error">
              <p>{problem.message}</p>
              <ul className="mt-1 list-disc pl-5">
                {problem.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </FormMessage>
          ) : (
            <ActionError message={problem.message} returnTo={returnTo} />
          )}
        </div>
      ) : null}
    </>
  )
}
