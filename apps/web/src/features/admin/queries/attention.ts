import 'server-only'

import { z } from 'zod'
import type { AdminSide } from '@/features/admin/lib/side'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * What needs a person on one side, for the sidebar's badges and the
 * overview's tiles (docs/ADMIN-SPEC.md §5.1). One SQL function counts it
 * all (`admin_attention_counts`): aggregates belong in SQL, and it refuses a
 * test admin the live side itself.
 */

const count = z.coerce.number().int().nonnegative().catch(0)

const attentionSchema = z.object({
  refunds: count,
  jobs: count,
  incidents: count,
  alertsCritical: count,
  alertsWarning: count,
  drift: count,
  stuckOrders: count,
  pendingWithoutJob: count,
  emailsFailed: count,
  ledgerUnexplained: count,
  presetDrafts: count,
})

export type AttentionCounts = z.infer<typeof attentionSchema>

/** Counts for the side, or null when they could not be read (the badges are left off). */
export async function getAttentionCounts(side: AdminSide): Promise<AttentionCounts | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_attention_counts', {
    p_test_mode: side === 'test',
  })
  if (error) {
    logger.warn({ code: error.code }, 'admin attention counts unavailable')
    return null
  }
  const parsed = attentionSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}
