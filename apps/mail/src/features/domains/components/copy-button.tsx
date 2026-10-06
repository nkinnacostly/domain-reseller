'use client'

import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Copies one DNS value (MAIL-SPEC §5: "each with a copy button"). Its name
 * says what it copies, so a screen reader hears more than "Copy" ten times
 * (S8); "Copied" is announced, and if the browser will not copy, the person
 * is told to select the text instead. 44px to touch (S7), with pressed and
 * focus states (S12).
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2_500)
    return () => clearTimeout(timer)
  }, [state])

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            setState('copied')
          } catch {
            setState('failed')
          }
        }}
        className={cn(
          'inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.96]',
          state === 'copied' && 'border-tone-success-foreground/40 text-tone-success-foreground',
        )}
      >
        {state === 'copied' ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </button>
      <span role="status" className="text-xs text-muted-foreground">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select the text and copy it' : ''}
      </span>
    </span>
  )
}
