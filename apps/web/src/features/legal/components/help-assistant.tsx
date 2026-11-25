'use client'

import { Sparkle } from 'lucide-react'
import Link from 'next/link'
import { useId, useState, useTransition } from 'react'
import {
  describedBy,
  FormMessage,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { cn } from '@/lib/utils'
import { type AskHelpResult, askHelp } from '../actions/ask-help'
import { QUESTION_MAX, QUESTION_MIN } from '../lib/help-assistant'

const REFUSAL: Record<Exclude<AskHelpResult, { ok: true }>['reason'], string> = {
  off: 'The help assistant isn’t switched on yet. The answers below cover most questions.',
  limited: 'You’ve asked a lot in a few minutes. Wait a little, then try again.',
  unavailable: 'We couldn’t get an answer just now. The answers below are always here.',
}

/**
 * The help assistant (feature 4): a question in, an answer drawn from the
 * help centre out, with the topics and pages it came from. It never quotes a
 * price, and when the help centre does not cover a question it says so and
 * offers a person instead.
 */
export function HelpAssistant({ supportEmail }: { supportEmail: string }) {
  const id = useId()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<AskHelpResult | null>(null)
  const [error, setError] = useState<string | undefined>()

  const submit = onSubmitWith((form) => {
    const question = String(form.get('question') ?? '').trim()
    if (question.length < QUESTION_MIN) {
      setError('Ask your question in a few words.')
      return
    }
    setError(undefined)
    startTransition(async () => {
      const answer = await askHelp({ question })
      setResult(answer?.data ?? { ok: false, reason: 'unavailable' })
    })
  })

  return (
    <div className="rounded-2xl border border-border bg-background p-4 sm:p-5">
      <form onSubmit={submit} aria-label="Ask a question" className="space-y-3" noValidate>
        <label htmlFor={`${id}-question`} className="text-sm font-medium text-foreground">
          Ask a question
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id={`${id}-question`}
            name="question"
            maxLength={QUESTION_MAX}
            placeholder="How do I point my domain at Vercel?"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(`${id}-question`, error, 'hint')}
            className={cn(inputClass, 'sm:flex-1')}
          />
          <SubmitButton pending={pending} pendingLabel="Looking…" className="sm:w-auto">
            <Sparkle className="size-4" aria-hidden="true" />
            Ask
          </SubmitButton>
        </div>
        {error ? (
          <p id={`${id}-question-error`} className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p id={`${id}-question-hint`} className="text-xs text-muted-foreground">
            Answered by AI from this help centre only. Your question goes to DeepSeek, an AI
            provider, with email addresses and phone numbers taken out; leave out anything personal.
          </p>
        )}
      </form>

      <div aria-live="polite" className={pending || result ? 'mt-4' : undefined}>
        {pending ? (
          <div aria-hidden="true" className="h-20 animate-pulse rounded-xl bg-muted/70" />
        ) : result && !result.ok ? (
          <FormMessage tone="error">{REFUSAL[result.reason]}</FormMessage>
        ) : result?.ok && !result.help.answered ? (
          <FormMessage tone="error">
            The help centre doesn’t cover that. Email{' '}
            <a href={`mailto:${supportEmail}`} className="font-medium underline underline-offset-2">
              {supportEmail}
            </a>{' '}
            and a person will answer.
          </FormMessage>
        ) : result?.ok && result.help.answered ? (
          <div className="rounded-xl bg-muted/50 px-4 py-3 text-sm/6">
            <p className="text-pretty text-foreground">{result.help.answer}</p>
            {result.help.sources.length > 0 ? (
              <p className="mt-2 text-muted-foreground">
                From:{' '}
                {result.help.sources.map((source, index) => (
                  <span key={source.path}>
                    {index > 0 ? ', ' : ''}
                    <Link
                      href={source.path}
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      {source.title}
                    </Link>
                  </span>
                ))}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">
              Still stuck? Email{' '}
              <a href={`mailto:${supportEmail}`} className="underline underline-offset-2">
                {supportEmail}
              </a>
              .
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
