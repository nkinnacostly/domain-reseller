'use client'

import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/**
 * An id or reference with a copy button. Never for personal data or secrets:
 * what is copied here sits on the clipboard for any app to read.
 */
export function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <code className="min-w-0 truncate font-mono text-sm text-foreground">{value}</code>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
          } catch {
            setCopied(false)
          }
        }}
        className={cn(
          'grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground active:scale-[0.95]',
          FOCUS,
        )}
      >
        {copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </button>
      <span role="status" className="sr-only">
        {copied ? `${label} copied` : ''}
      </span>
    </span>
  )
}
