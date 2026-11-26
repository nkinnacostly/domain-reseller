import 'server-only'

import { type AiReport, parseAiReport } from '@/features/admin/lib/ai-report'
import type { AdminSide } from '@/features/admin/lib/side'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/** The WAT day `days` before `now`, and today, as `YYYY-MM-DD`. */
export function watWindow(now: Date, days: number): { from: string; to: string } {
  const watToday = new Date(now.getTime() + 60 * 60_000).toISOString().slice(0, 10)
  const from = new Date(Date.parse(`${watToday}T00:00:00Z`) - (days - 1) * 86_400_000)
  return { from: from.toISOString().slice(0, 10), to: watToday }
}

/**
 * `admin_ai_report` (migration 75) as this admin, for the side shown: the
 * admin read gate refuses a test admin the live side, and gives one no spend.
 */
export async function getAiReport(
  side: AdminSide,
  window: { from: string; to: string },
): Promise<AiReport | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_ai_report', {
    p_test_mode: side === 'test',
    p_from: window.from,
    p_to: window.to,
  })
  if (error) {
    logger.warn({ code: error.code }, 'admin ai: report unavailable')
    return null
  }
  const report = parseAiReport(data)
  if (!report) logger.error('admin ai: the report answered an unexpected shape')
  return report
}
