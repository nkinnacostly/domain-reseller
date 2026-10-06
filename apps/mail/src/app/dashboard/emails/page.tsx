import { Inbox } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { Container } from '@/components/layout/container'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { PartError } from '@/features/accounts/components/overview-parts'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { EmailLog } from '@/features/emails/components/email-log'
import { EmailSearch } from '@/features/emails/components/email-search'
import { readSearch, searchHref } from '@/features/emails/lib/search'
import { getEmailLog } from '@/features/emails/queries/log'

export const metadata: Metadata = { title: 'Emails' }

type Params = Promise<Record<string, string | string[] | undefined>>

const LINK =
  'rounded-sm font-medium text-brand-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const PAGER =
  'inline-flex min-h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]'

/**
 * The email log (MAIL-SPEC §10 Emails): every email this account queued,
 * newest first, searchable by id, exact recipient, subject, tag, status and
 * day; each row's status; a page per email. Read through SQL as the member
 * (`account_emails`, migration 48). Four states (S11): loading, nothing yet
 * (or nothing matching), an error with a retry, the rows.
 */
async function Log({ searchParams }: { searchParams: Params }) {
  const [data, params] = await Promise.all([getCurrentAccount(), searchParams])
  if (!data) return null
  const search = readSearch(params)
  const invalid = Object.keys(search.errors).length > 0
  const log = invalid
    ? null
    : await getEmailLog(data.current.account.id, search.filters, search.cursor)
  const self = searchHref(search.values, search.cursor ?? undefined)

  return (
    <div className="space-y-6">
      <EmailSearch search={search} />
      <section aria-labelledby="results-heading" className="space-y-4">
        <h2 id="results-heading" className="sr-only">
          {search.isFiltered ? 'Emails matching your search' : 'Emails'}
        </h2>
        {invalid ? (
          <p className="text-sm text-muted-foreground">Fix the search above to see emails.</p>
        ) : !log ? (
          <PartError what="the email log" retryHref={self} />
        ) : log.emails.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border px-5 py-10 text-center">
            <Inbox className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
            {search.isFiltered ? (
              <>
                <p className="mt-3 font-medium">No emails match this search</p>
                <p className="mt-1 text-pretty text-sm text-muted-foreground">
                  A recipient must match the whole address. Try fewer fields, or{' '}
                  <Link href="/dashboard/emails" className={LINK}>
                    clear the search
                  </Link>
                  .
                </p>
              </>
            ) : (
              <>
                <p className="mt-3 font-medium">No emails yet</p>
                <p className="mt-1 text-pretty text-sm text-muted-foreground">
                  Every email your app sends shows here, with what happened to it. Send one with an{' '}
                  <Link href="/dashboard/api-keys" className={LINK}>
                    API key
                  </Link>{' '}
                  and the{' '}
                  <Link href="/docs/quickstart" className={LINK}>
                    quickstart
                  </Link>
                  .
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            <EmailLog emails={log.emails} />
            {log.next || search.cursor ? (
              <nav aria-label="Pages of the log" className="flex flex-wrap gap-3">
                {search.cursor ? (
                  <Link href={searchHref(search.values)} className={PAGER}>
                    Back to the newest
                  </Link>
                ) : null}
                {log.next ? (
                  <Link href={searchHref(search.values, log.next)} className={PAGER}>
                    Older emails
                  </Link>
                ) : null}
              </nav>
            ) : null}
          </>
        )}
      </section>
    </div>
  )
}

export default function EmailsPage({ searchParams }: { searchParams: Params }) {
  return (
    <Container className="space-y-6 py-6 sm:py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Emails</h1>
        <p className="mt-1 max-w-2xl text-pretty text-sm text-muted-foreground">
          Every email this account queued, newest first, with its status. Times are Lagos time.
        </p>
      </div>
      <Suspense fallback={<PageSkeleton />}>
        <Log searchParams={searchParams} />
      </Suspense>
    </Container>
  )
}
