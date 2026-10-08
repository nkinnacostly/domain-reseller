'use client'

import { useRouter } from 'next/navigation'
import { useId, useRef, useState } from 'react'
import {
  describedBy,
  Field,
  FormMessage,
  inputClass,
  SubmitButton,
} from '@/components/common/form-parts'
import { cn } from '@/lib/utils'
import { type ImportCounts, importSuppressions } from '../actions/suppressions'
import { IMPORT_LIMITS, importChunks, type ReadList, readSuppressionList } from '../lib/import'
import { IMPORT_FALLBACK, IMPORT_REASON, type SuppressionReason } from '../lib/words'

/**
 * "Import a list" (migration 68): the addresses that bounced, complained or
 * unsubscribed at another provider, so this account never sends to them.
 * The file is read here, in the browser — only the addresses it holds are
 * sent, a chunk at a time, with progress; a failure keeps what was added and
 * offers to carry on from where it stopped. Owners and admins only; SQL
 * checks again.
 */

type Phase =
  | { name: 'idle' }
  | { name: 'reading' }
  | { name: 'ready'; file: string; list: ReadList }
  | { name: 'importing'; file: string; list: ReadList; sent: number }
  | { name: 'done'; totals: ImportCounts }
  | { name: 'stopped'; file: string; list: ReadList; sent: number; next: number; error: string }

const n = (value: number) => new Intl.NumberFormat('en-NG').format(value)
const addresses = (value: number) => `${n(value)} ${value === 1 ? 'address' : 'addresses'}`
const were = (value: number) => `${n(value)} ${value === 1 ? 'was' : 'were'}`

const ZERO: ImportCounts = { added: 0, already: 0, invalid: 0 }

export function ImportSuppressions({ accountId }: { accountId: string }) {
  const id = useId()
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const [reason, setReason] = useState<SuppressionReason>('bounce')
  const [fileError, setFileError] = useState<string | undefined>()
  const totals = useRef<ImportCounts>(ZERO)

  async function read(file: File | undefined) {
    setFileError(undefined)
    if (!file) return setPhase({ name: 'idle' })
    if (file.size > IMPORT_LIMITS.maxFileBytes) {
      setPhase({ name: 'idle' })
      return setFileError('The file is larger than 10 MB. Split it, and import each part.')
    }
    setPhase({ name: 'reading' })
    const list = readSuppressionList(await file.text())
    if (list.addresses.length === 0) {
      setPhase({ name: 'idle' })
      return setFileError(
        'There are no email addresses in this file. Choose a CSV export, or a text file with one address a line.',
      )
    }
    totals.current = ZERO
    setPhase({ name: 'ready', file: file.name, list })
  }

  async function run(file: string, list: ReadList, from: number) {
    const chunks = importChunks(list.addresses)
    let sent = chunks.slice(0, from).reduce((sum, chunk) => sum + chunk.length, 0)
    for (let index = from; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? []
      setPhase({ name: 'importing', file, list, sent })
      let error: string | null = null
      try {
        const result = await importSuppressions({ accountId, reason, addresses: chunk })
        const data = result?.data
        if (data && 'ok' in data) {
          totals.current = {
            added: totals.current.added + data.added,
            already: totals.current.already + data.already,
            invalid: totals.current.invalid + data.invalid,
          }
        } else {
          error =
            (data && 'error' in data ? data.error : null) ?? result?.serverError ?? IMPORT_FALLBACK
        }
      } catch {
        error =
          'The connection dropped, and this part of the list was not added. Carry on to try again.'
      }
      if (error) {
        setPhase({ name: 'stopped', file, list, sent, next: index, error })
        router.refresh()
        return
      }
      sent += chunk.length
    }
    setPhase({ name: 'done', totals: totals.current })
    if (fileInput.current) fileInput.current.value = ''
    router.refresh()
  }

  const busy = phase.name === 'importing' || phase.name === 'reading'
  const list = 'list' in phase ? phase.list : null

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="max-w-3xl rounded-3xl border border-border bg-card p-5 sm:p-6"
    >
      <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-tight">
        Import a list
      </h2>
      <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
        Moving from Resend, SendGrid, Mailgun, Brevo or another provider? Bring the addresses that
        bounced, complained or unsubscribed there, so this account never sends to them. Use their
        CSV export, or a text file with one address a line. The file is read in your browser; only
        the addresses are sent.
      </p>

      <form
        aria-label="Import a suppression list"
        className="mt-5 space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          if (phase.name === 'ready') void run(phase.file, phase.list, 0)
        }}
      >
        <Field
          id={`${id}-file`}
          label="The list"
          hint={`CSV or text, up to 10 MB and ${n(IMPORT_LIMITS.maxAddresses)} addresses.`}
          error={fileError}
        >
          <input
            ref={fileInput}
            id={`${id}-file`}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            disabled={phase.name === 'importing'}
            aria-invalid={fileError ? true : undefined}
            aria-describedby={describedBy(`${id}-file`, fileError, 'hint')}
            onChange={(event) => void read(event.currentTarget.files?.[0])}
            className={cn(
              inputClass,
              'h-auto min-h-11 cursor-pointer py-1.5 file:mr-3 file:min-h-8 file:cursor-pointer file:rounded-full file:border-0 file:bg-secondary file:px-4 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80',
            )}
          />
        </Field>

        {list ? (
          <p className="text-pretty text-sm/6" role="status">
            Found <strong>{addresses(list.addresses.length)}</strong> in{' '}
            <span className="break-all">{'file' in phase ? phase.file : ''}</span>.
            {list.skipped > 0
              ? ` ${n(list.skipped)} ${list.skipped === 1 ? 'row has' : 'rows have'} no address we could read, and ${list.skipped === 1 ? 'is' : 'are'} left out.`
              : ''}
            {list.truncated
              ? ` One import takes ${n(IMPORT_LIMITS.maxAddresses)}: import the rest as another file.`
              : ''}
          </p>
        ) : null}

        {list ? (
          <fieldset disabled={phase.name === 'importing'}>
            <legend className="text-sm font-medium">Why were they on that list?</legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              {(Object.keys(IMPORT_REASON) as SuppressionReason[]).map((option) => (
                <label
                  key={option}
                  className="flex cursor-pointer gap-3 rounded-2xl border border-border bg-background p-4 transition-colors hover:border-foreground/40 has-[:checked]:border-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70"
                >
                  <input
                    type="radio"
                    name="reason"
                    value={option}
                    checked={reason === option}
                    onChange={() => setReason(option)}
                    className="mt-1 size-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{IMPORT_REASON[option].label}</span>
                    <span className="mt-0.5 block text-xs/5 text-muted-foreground">
                      {IMPORT_REASON[option].hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs/5 text-muted-foreground">
              One reason for the whole file. Import a provider’s bounces and its unsubscribes as two
              files to keep them apart.
            </p>
          </fieldset>
        ) : null}

        {phase.name === 'importing' ? (
          <div className="space-y-2">
            <div
              role="progressbar"
              aria-label="Import progress"
              aria-valuemin={0}
              aria-valuemax={phase.list.addresses.length}
              aria-valuenow={phase.sent}
              aria-valuetext={`${n(phase.sent)} of ${n(phase.list.addresses.length)}`}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${(phase.sent / phase.list.addresses.length) * 100}%` }}
              />
            </div>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {n(phase.sent)} of {n(phase.list.addresses.length)} sent. Keep this page open.
            </p>
          </div>
        ) : null}

        {phase.name === 'done' ? (
          <FormMessage tone="success">
            Added {addresses(phase.totals.added)} to the list.
            {phase.totals.already > 0 ? ` ${were(phase.totals.already)} on it already.` : ''}
            {phase.totals.invalid > 0
              ? ` ${were(phase.totals.invalid)} not addresses we can store.`
              : ''}
          </FormMessage>
        ) : null}

        {phase.name === 'stopped' ? (
          <FormMessage tone="error">
            {phase.error}{' '}
            {totals.current.added > 0
              ? `${addresses(totals.current.added)} ${totals.current.added === 1 ? 'was' : 'were'} added before it stopped.`
              : ''}
          </FormMessage>
        ) : null}

        {phase.name === 'stopped' ? (
          <button
            type="button"
            onClick={() => void run(phase.file, phase.list, phase.next)}
            className="inline-flex h-11 w-full items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] sm:w-auto"
          >
            Carry on from where it stopped
          </button>
        ) : list && phase.name !== 'done' ? (
          <SubmitButton pending={busy} pendingLabel="Importing…" className="sm:w-auto">
            Add {addresses(list.addresses.length)} to the list
          </SubmitButton>
        ) : null}
      </form>
    </section>
  )
}
