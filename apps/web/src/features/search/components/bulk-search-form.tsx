'use client'

import { FileUp, ListChecks } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { BULK_MAX_NAMES, countNames, planBulk } from '../lib/bulk'
import { describeCsvRead, readNamesFromCsv } from '../lib/csv'
import { toUnicodeHost } from '../lib/idn'
import type { LengthRules } from '../lib/length'
import { useBulkRun } from './bulk-run'

/** Far larger than 500 names; a bound on what the browser is asked to read. */
const MAX_CSV_BYTES = 1_000_000

const tooMany = (count: number) =>
  `That's ${count.toLocaleString('en-NG')} names. Bulk search checks up to ${BULK_MAX_NAMES} at a time — remove some, or check them in two goes.`

/**
 * Bulk search (PRD FR-S5): up to 500 names, typed, pasted or read from a CSV
 * file, and the extensions to try names typed without one on.
 *
 * The list is planned here and checked from the page, block by block, so
 * progress and partial results show as they arrive (see BulkRunProvider).
 * `action`/`method` stay so a submit before hydration still arrives — the page
 * reads `?names=` and `?tld=` back into this form and checks them once it is
 * ready. The field is uncontrolled on purpose (see DomainSearch); a CSV file
 * is read in the browser and its names written into it, to be looked over
 * before checking.
 */
export function BulkSearchForm({
  extensions,
  sold,
  featured,
  lengthRules,
  defaultNames = '',
  defaultPicked,
  autoRun = false,
}: {
  /** Extensions offered for names without one, lead first. */
  extensions: readonly string[]
  /** Every extension we sell. */
  sold: readonly string[]
  featured: readonly string[]
  lengthRules: LengthRules
  defaultNames?: string
  /** Ticked when the page opens: the ones in the address, else the lead one. */
  defaultPicked: readonly string[]
  /** Names arrived in the address: check them as soon as the page can. */
  autoRun?: boolean
}) {
  const { run, start } = useBulkRun()
  const id = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const namesRef = useRef<HTMLTextAreaElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [fileNote, setFileNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [isEnhanced, setIsEnhanced] = useState(false)
  const soldSet = useMemo(() => new Set(sold), [sold])
  const isRunning = run?.running ?? false

  useEffect(() => setIsEnhanced(true), [])

  // Once only, even when React runs effects twice in development.
  const autoRan = useRef(false)
  useEffect(() => {
    if (!autoRun || autoRan.current) return
    autoRan.current = true
    formRef.current?.requestSubmit()
  }, [autoRun])

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isRunning) return
    const form = new FormData(event.currentTarget)
    const text = String(form.get('names') ?? '')
    const count = countNames(text)

    if (count === 0) {
      setError('Type or paste at least one name, or upload a CSV file.')
      return
    }
    if (count > BULK_MAX_NAMES) {
      setError(tooMany(count))
      return
    }

    setError(null)
    start(
      planBulk({
        text,
        picked: form.getAll('tld').map(String),
        sold: soldSet,
        featured,
        lengthRules,
      }),
    )
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    // Cleared, so choosing the same file again reads it again.
    input.value = ''
    if (!file) return
    if (file.size > MAX_CSV_BYTES) {
      setFileNote({
        tone: 'error',
        text: `${file.name} is larger than 1 MB — too big for a list of names. Save just the names column and try again.`,
      })
      return
    }

    let text: string
    try {
      text = await file.text()
    } catch {
      setFileNote({
        tone: 'error',
        text: `We couldn't read ${file.name}. Save it as CSV (comma separated) and try again.`,
      })
      return
    }

    const read = readNamesFromCsv(text)
    if (read.names.length === 0) {
      setFileNote({
        tone: 'error',
        text: `We found no names in ${file.name}. Put one name per row, in the first column or a column headed “domain”.`,
      })
      return
    }
    if (namesRef.current) namesRef.current.value = read.names.join('\n')
    setError(null)
    setFileNote(
      read.names.length > BULK_MAX_NAMES
        ? {
            tone: 'error',
            text: `${describeCsvRead(file.name, read)} ${tooMany(read.names.length)}`,
          }
        : {
            tone: 'ok',
            text: `${describeCsvRead(file.name, read)} Check the list, then press Check names.`,
          },
    )
  }

  return (
    <form
      ref={formRef}
      action="/search/bulk"
      method="get"
      onSubmit={onSubmit}
      noValidate
      aria-label="Bulk search"
      data-enhanced={isEnhanced ? 'true' : undefined}
      className="w-full rounded-3xl bg-background p-4 text-foreground shadow-[0_18px_40px_-18px_rgb(0_0_0/0.25)] sm:p-6"
    >
      <label htmlFor={`${id}-names`} className="block text-sm font-medium text-foreground">
        Names to check
      </label>
      <p id={`${id}-hint`} className="mt-1 text-pretty text-xs/5 text-muted-foreground">
        One per line, up to {BULK_MAX_NAMES} — or upload a CSV file. With an extension (getpaid.com)
        or without (getpaid). Names in any script work, like café.com.
      </p>
      <textarea
        ref={namesRef}
        id={`${id}-names`}
        name="names"
        rows={7}
        defaultValue={defaultNames}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={'getpaid\nmybrand.africa\ncafé.com'}
        onChange={() => {
          if (error) setError(null)
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
        className="mt-3 block w-full resize-y rounded-2xl border border-input bg-background px-3.5 py-3 font-mono text-base text-foreground outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
      />

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <label className="inline-flex min-h-11 w-fit shrink-0 cursor-pointer items-center gap-2 rounded-full border border-border px-4 text-sm font-medium transition hover:bg-muted active:scale-[0.98] has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring">
          <FileUp className="size-4" aria-hidden="true" />
          Upload a CSV file
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={onFile}
            aria-describedby={`${id}-file`}
            className="sr-only"
          />
        </label>
        <p
          id={`${id}-file`}
          role="status"
          className={cn(
            'text-pretty text-xs/5 sm:pt-3',
            fileNote?.tone === 'error' ? 'font-medium text-destructive' : 'text-muted-foreground',
          )}
        >
          {fileNote?.text ?? 'Names from the first column, or one headed “domain” or “name”.'}
        </p>
      </div>

      <fieldset className="mt-5">
        <legend className="text-sm font-medium text-foreground">
          Check names without an extension on
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {extensions.map((tld) => (
            <label
              key={tld}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-border px-4 text-sm font-medium transition hover:bg-muted has-checked:border-accent/50 has-checked:bg-accent/10 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
            >
              <input
                type="checkbox"
                name="tld"
                value={tld}
                defaultChecked={defaultPicked.includes(tld)}
                className="size-4 accent-accent"
              />
              .{toUnicodeHost(tld)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button
          type="submit"
          size="lg"
          disabled={isRunning}
          aria-busy={isRunning || undefined}
          className="h-12 shrink-0 rounded-full bg-accent px-7 text-base font-medium text-accent-foreground hover:bg-accent/90 active:scale-[0.98]"
        >
          {isRunning ? (
            <>
              <Spinner className="size-4" aria-hidden="true" />
              Checking…
            </>
          ) : (
            <>
              <ListChecks className="size-4" aria-hidden="true" />
              Check names
            </>
          )}
        </Button>
        <p
          id={`${id}-error`}
          role={error ? 'alert' : undefined}
          hidden={!error}
          className="text-pretty text-sm font-medium text-destructive"
        >
          {error}
        </p>
      </div>
    </form>
  )
}
