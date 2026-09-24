import 'server-only'

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { type DomainLabel, sortLabels, toLabel } from '../lib/labels'

export type LabelWithCount = DomainLabel & { domainCount: number }

/**
 * FR-P3 — the account's labels, by name, each with how many of its domains
 * carry it. Read as the user: RLS returns only their own (migration 32).
 * Null when they could not be read, so a page can say so rather than show
 * an account with none. Request-scoped: the portfolio's filter and its bulk
 * bar share one read.
 */
export const getLabels = cache(async (): Promise<LabelWithCount[] | null> => {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('domain_labels')
    .select('id, name, color, domain_label_links(count)')
    .order('name')
  if (error) return null
  return sortLabels(
    (data ?? []).map((row) => ({
      ...toLabel(row),
      domainCount: Number(row.domain_label_links?.[0]?.count ?? 0),
    })),
  )
})
