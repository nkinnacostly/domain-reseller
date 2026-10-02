import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { RefreshWhile } from '@/components/common/refresh-while'
import {
  FOCUS,
  PANEL_HEADING,
  Panel,
  PanelHeader,
  PanelPage,
  PanelPageSkeleton,
} from '@/components/layout/panel'
import { BulkResults, BulkSummary } from '@/features/domains/components/bulk-results'
import { type BulkLine, bulkTitle, isBulkSettling } from '@/features/domains/lib/bulk'
import { type BulkOperation, getBulkOperation } from '@/features/domains/queries/bulk'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Bulk change' }

type Params = Promise<{ id: string }>

const startedFormat = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
})

const CRUMBS = [
  { label: 'Home', href: '/' },
  { label: 'Dashboard', href: '/app/domains' },
  { label: 'Bulk change' },
]

function BackLink() {
  return (
    <Link
      href="/app/domains#portfolio"
      className={cn(
        'inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-brand-subtle active:scale-[0.98]',
        FOCUS,
      )}
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to your domains
    </Link>
  )
}

/** What the settling state says, while jobs are still with the registry. */
function progressNote(lines: readonly BulkLine[]): string | null {
  return isBulkSettling(lines)
    ? 'Changes are on their way to the registry. This page updates as each one is applied.'
    : null
}

function describe(operation: BulkOperation): string {
  const started = `Started ${startedFormat.format(new Date(operation.createdAt))}.`
  const nameservers = operation.params.nameservers
  if (operation.kind === 'nameservers' && Array.isArray(nameservers)) {
    return `${started} Asked for: ${nameservers.join(', ')}.`
  }
  return started
}

async function Results({ params }: { params: Params }) {
  const { id } = await params
  let operation: BulkOperation | null
  try {
    operation = await getBulkOperation(id)
  } catch {
    return (
      <>
        <PanelHeader crumbs={CRUMBS} title="Bulk change" />
        <FormMessage tone="error">
          This change’s results couldn’t be loaded just now. Nothing about it has been lost.{' '}
          <a href={`/app/domains/bulk/${id}`} className="font-medium underline underline-offset-2">
            Try again
          </a>
        </FormMessage>
      </>
    )
  }
  if (!operation) notFound()

  const note = progressNote(operation.lines)
  return (
    <>
      <PanelHeader
        crumbs={CRUMBS}
        title={bulkTitle(
          operation.kind,
          operation.params,
          operation.lines.length,
          operation.labelName,
        )}
        description={describe(operation)}
      >
        <div className="space-y-3">
          <BulkSummary lines={operation.lines} />
          {note ? <FormMessage tone="success">{note}</FormMessage> : null}
        </div>
      </PanelHeader>
      <RefreshWhile active={note !== null} />

      <Panel labelledBy="lines-heading">
        <h2 id="lines-heading" className={PANEL_HEADING}>
          Each domain
        </h2>
        <div className="mt-4">
          <BulkResults
            kind={operation.kind}
            params={operation.params}
            lines={operation.lines}
            domains={operation.domains}
          />
        </div>
        <div className="mt-5">
          <BackLink />
        </div>
      </Panel>
    </>
  )
}

/** FR-P4 — a bulk change's result for each domain, updating while jobs run. */
export default function BulkResultsPage({ params }: { params: Params }) {
  return (
    <PanelPage>
      <Suspense fallback={<PanelPageSkeleton height="h-72" />}>
        <Results params={params} />
      </Suspense>
    </PanelPage>
  )
}
