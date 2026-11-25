'use client'

import { Sparkle } from 'lucide-react'
import { useState, useTransition } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import { explainSetup, type SetupHelpResult } from '../actions/setup-help'

const REFUSAL: Record<Exclude<SetupHelpResult, { ok: true }>['reason'], string> = {
  off: 'The assistant isn’t switched on yet.',
  not_found: 'We couldn’t find this domain in your account.',
  limited: 'You’ve asked a lot in a few minutes. Wait a little, then try again.',
  unavailable: 'We couldn’t get an explanation just now. The resolver list above is still live.',
}

/**
 * Feature 3 — "Explain what's happening", on the Nameservers tab. Asked for,
 * not run on its own; the live check above stays the source of truth.
 */
export function SetupHelpPanel({ domain }: { domain: string }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<SetupHelpResult | null>(null)

  const ask = () =>
    startTransition(async () => {
      const answer = await explainSetup({ domain })
      setResult(answer?.data ?? { ok: false, reason: 'unavailable' })
    })

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={ask}
        disabled={pending}
        aria-busy={pending || undefined}
        className="inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? (
          <Spinner className="size-4" aria-hidden="true" />
        ) : (
          <Sparkle className="size-4" aria-hidden="true" />
        )}
        {pending ? 'Reading the checks…' : 'Explain what’s happening'}
      </button>
      <p className="text-xs text-muted-foreground">
        Sent to DeepSeek, an AI provider: the nameservers and the check results above, without your
        domain’s name.
      </p>

      <div aria-live="polite">
        {pending ? (
          <div aria-hidden="true" className="h-24 animate-pulse rounded-2xl bg-muted/70" />
        ) : result && !result.ok ? (
          <FormMessage tone="error">{REFUSAL[result.reason]}</FormMessage>
        ) : result?.ok ? (
          <div className="rounded-2xl border border-border bg-background px-4 py-3.5 text-sm/6">
            <p className="text-pretty text-foreground">{result.help.summary}</p>
            {result.help.steps.length > 0 ? (
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-pretty text-muted-foreground">
                {result.help.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
