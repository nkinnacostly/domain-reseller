import 'server-only'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import {
  BULK_KINDS,
  type BulkKind,
  type BulkLine,
  type BulkParams,
  type LineDomain,
} from '../lib/bulk'
import { chunk, IDS_PER_READ } from '../lib/chunks'

export type BulkOperation = {
  id: string
  kind: BulkKind
  params: BulkParams
  createdAt: string
  lines: BulkLine[]
  /** Each line's domain as it is now, for wording a line (demo, registering). */
  domains: Record<string, LineDomain>
  /** The label a label action was about — null once deleted. */
  labelName: string | null
}

const OUTCOMES = ['queued', 'done', 'skipped'] as const

/**
 * FR-P4 — one bulk operation and its lines, read as the user: RLS shows the
 * operation only to its owner, and `my_bulk_operation` joins each line to
 * its job's progress without opening the jobs table (migration 32).
 * Null when it is not theirs, or not an operation at all. Throws when it
 * cannot be read, so the page shows its error state rather than "not found".
 */
export async function getBulkOperation(id: string): Promise<BulkOperation | null> {
  if (!z.uuid().safeParse(id).success) return null
  const supabase = await createClient()
  const [operation, lines] = await Promise.all([
    supabase
      .from('bulk_operations')
      .select('id, kind, params, created_at')
      .eq('id', id)
      .maybeSingle(),
    supabase.rpc('my_bulk_operation', { p_operation_id: id }),
  ])
  if (operation.error || lines.error) throw new Error('bulk operation could not be read')
  const row = operation.data
  if (!row || !(BULK_KINDS as readonly string[]).includes(row.kind)) return null

  const kind = row.kind as BulkKind
  const params = (row.params ?? {}) as BulkParams
  const bulkLines: BulkLine[] = (lines.data ?? []).map((line) => ({
    domainId: line.domain_id,
    domainName: line.domain_name,
    outcome: (OUTCOMES as readonly string[]).includes(line.outcome)
      ? (line.outcome as BulkLine['outcome'])
      : 'skipped',
    reason: line.reason,
    jobStatus: line.job_status,
    jobErrorCode: line.job_error_code,
  }))

  const reads = await Promise.all(
    chunk(
      bulkLines.map((line) => line.domainId),
      IDS_PER_READ,
    ).map((ids) => supabase.from('domains').select('id, source, local_status').in('id', ids)),
  )
  const domains: Record<string, LineDomain> = {}
  for (const read of reads) {
    for (const domain of read.data ?? []) {
      domains[domain.id] = { source: domain.source, status: domain.local_status }
    }
  }

  let labelName: string | null = null
  if ((kind === 'label' || kind === 'unlabel') && typeof params.label_id === 'string') {
    const { data: label } = await supabase
      .from('domain_labels')
      .select('name')
      .eq('id', params.label_id)
      .maybeSingle()
    labelName = label?.name ?? null
  }

  return {
    id: row.id,
    kind,
    params,
    createdAt: row.created_at,
    lines: bulkLines,
    domains,
    labelName,
  }
}
