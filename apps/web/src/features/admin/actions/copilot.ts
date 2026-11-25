'use server'

import {
  type AlertHelp,
  alertHelpAnswer,
  alertHelpRequest,
  askForJson,
  cleanAlertHelp,
  maskForModel,
} from '@dr/shared/ai'
import { z } from 'zod'
import { alertKindLabel } from '@/features/admin/lib/alerts-copy'
import {
  ADMIN_ERROR_WORDS,
  type AdminResult,
  adminAccessError,
  toAdminResult,
} from '@/features/admin/lib/errors'
import { alertHelpSchema } from '@/features/admin/schemas/copilot'
import { aiSettings } from '@/lib/ai'
import { logger } from '@/lib/logger'
import { LIMITS, withinLimit } from '@/lib/rate-limit'
import { adminAction } from '@/lib/safe-action'

/**
 * The ops copilot (migration 74; docs: "Making AI the core of MyDomainsHub",
 * feature 5): one alert explained, or drafted into a ticket for
 * DomainNameAPI. The request is audited by `admin_alert_help`, which answers
 * with the alert's own words for the admin's side; domain names and contact
 * details are masked before the model sees them and put back here. It reads
 * and drafts only — nothing is sent or changed. Neither the alert's words
 * nor the answer is logged (N13).
 */

const answered = z.object({
  ok: z.literal(true),
  auditId: z.number(),
  alert: z.object({
    kind: z.string(),
    severity: z.string(),
    summary: z.string(),
    side: z.enum(['live', 'test']),
  }),
})

const refused = (code: string, auditId?: number): AdminResult<AlertHelp> => ({
  ok: false,
  code,
  message: ADMIN_ERROR_WORDS[code] ?? code,
  ...(auditId === undefined ? {} : { auditId }),
})

export const askAlertHelp = adminAction('alert.explain', alertHelpSchema).action(
  async ({ parsedInput, ctx }): Promise<AdminResult<AlertHelp>> => {
    const settings = aiSettings()
    if (!settings) return refused('AI_OFF')
    if (!(await withinLimit(`alert_help:admin:${ctx.admin.userId}`, LIMITS.alertHelp))) {
      return refused('COPILOT_BUSY')
    }
    const { data, error } = await ctx.db.rpc('admin_alert_help', {
      p_alert_id: parsedInput.alertId,
      p_mode: parsedInput.mode,
      p_request_key: parsedInput.requestKey,
    })
    if (error) throw adminAccessError(error.message)
    const parsed = answered.safeParse(data)
    if (!parsed.success) return toAdminResult(data) as AdminResult<AlertHelp>
    const { alert, auditId } = parsed.data
    const masked = maskForModel(alert.summary)
    const answer = await askForJson(
      settings,
      alertHelpRequest(
        {
          kind: alert.kind,
          kindLabel: alertKindLabel(alert.kind),
          severity: alert.severity,
          summary: masked.text,
          page: parsedInput.page,
          side: alert.side,
        },
        parsedInput.mode,
      ),
      alertHelpAnswer,
    )
    if (!answer.ok) {
      logger.warn({ auditId, reason: answer.reason }, 'ops copilot: no answer')
      return refused('AI_UNAVAILABLE', auditId)
    }
    const help = cleanAlertHelp(answer.value, parsedInput.mode, masked.names)
    if (!help) return refused('AI_UNAVAILABLE', auditId)
    return { ok: true, auditId, data: help }
  },
)
