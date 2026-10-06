'use client'

import { Check, Copy } from 'lucide-react'
import { useId, useState } from 'react'
import { FormMessage, inputClass } from '@/components/common/form-parts'
import { cn } from '@/lib/utils'

/**
 * A signing secret, shown once (MAIL-SPEC §10, MR6). It lives only in this
 * component's state: leaving the page or pressing "Done" forgets it, and the
 * server keeps it sealed — nobody can show it again.
 */
export function SecretReveal({
  secret,
  title,
  onDone,
}: {
  secret: string
  title: string
  onDone: () => void
}) {
  const id = useId()
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)

  return (
    <div className="space-y-4" data-secret-reveal>
      <FormMessage tone="success">
        <p className="font-medium">{title}</p>
        <p>
          Copy the signing secret now and keep it with your endpoint’s settings. We keep it sealed
          and cannot show it again; if you lose it, make a new one.
        </p>
      </FormMessage>
      <div>
        <label htmlFor={`${id}-secret`} className="text-sm font-medium">
          Signing secret
        </label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input
            id={`${id}-secret`}
            readOnly
            value={secret}
            autoComplete="off"
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            className={cn(inputClass, 'font-mono text-sm')}
          />
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(secret)
                setCopied('yes')
              } catch {
                setCopied('failed')
              }
            }}
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            {copied === 'yes' ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copied === 'yes' ? 'Copied' : 'Copy secret'}
          </button>
        </div>
        <p role="status" className="mt-1.5 min-h-5 text-xs text-muted-foreground">
          {copied === 'failed' ? 'Copying did not work here: select the secret and copy it.' : ''}
        </p>
      </div>
      <button
        type="button"
        onClick={onDone}
        className="inline-flex min-h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
      >
        I have saved it
      </button>
    </div>
  )
}
