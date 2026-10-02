'use client'

import { Check, Copy, Download } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

const BUTTON = cn(
  'inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted active:scale-[0.98] disabled:opacity-60',
  FOCUS,
)

/**
 * A text file shown in place, with Copy and Download (FR-SSL-7). Everything
 * happens in the browser: nothing is sent anywhere. The text box scrolls on
 * its own (S5), so a long certificate never widens the page.
 */
export function TextFile({
  label,
  fileName,
  content,
  rows = 8,
}: {
  label: string
  fileName: string
  content: string
  rows?: number
}) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = `file-${fileName.replace(/[^a-z0-9-]/gi, '-')}`

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  async function copy() {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setFailed(false)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2_000)
    } catch {
      setFailed(true)
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/x-pem-file' }))
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        <span className="font-mono text-xs break-all text-muted-foreground">{fileName}</span>
      </div>
      <textarea
        id={id}
        readOnly
        value={content}
        rows={rows}
        spellCheck={false}
        className="mt-1.5 block w-full resize-y rounded-xl border border-input bg-muted/40 p-3 font-mono text-xs/5 text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copy}
          aria-label={`${copied ? 'Copied' : 'Copy'} ${label}`}
          className={BUTTON}
        >
          {copied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={download}
          aria-label={`Download ${fileName}`}
          className={BUTTON}
        >
          <Download className="size-4" aria-hidden="true" />
          Download
        </button>
      </div>
      {failed ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          Your browser would not copy it. Select the text above and copy it yourself, or download
          the file.
        </p>
      ) : null}
    </div>
  )
}
