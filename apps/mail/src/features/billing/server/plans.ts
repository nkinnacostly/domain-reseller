import 'server-only'

import { logger } from '@/lib/logger'
import type { MailServiceClient } from '@/lib/supabase/service'
import { planObjectName } from '../lib/flutterwave'
import type { BillingSettings } from './env'
import { createPaymentPlan } from './flutterwave'

/**
 * The Flutterwave payment plan object for one of our plans, made on demand
 * (MAIL-SPEC §8). SQL says what it must charge — the plan's price plus VAT,
 * from mail.plans and mail.billing_settings (N5b) — and records it per side
 * and per API host; made twice at once, the first recorded wins, and the
 * other object at Flutterwave is never used.
 */
export async function ensureFlutterwavePlan(
  service: MailServiceClient,
  settings: BillingSettings,
  planCode: string,
): Promise<number | null> {
  const { data, error } = await service.rpc('flutterwave_plan_for', {
    p_plan_code: planCode,
    p_test_mode: settings.testMode,
    p_api_host: settings.apiHost,
  })
  const want = data as {
    ok?: boolean
    planName?: string
    amountKobo?: number
    flutterwavePlanId?: number | null
  } | null
  if (error || want?.ok !== true || typeof want.amountKobo !== 'number' || !want.planName) {
    logger.error({ planCode, code: error?.code }, 'no plan object to charge')
    return null
  }
  if (typeof want.flutterwavePlanId === 'number') return want.flutterwavePlanId

  const made = await createPaymentPlan(settings, {
    name: planObjectName(want.planName),
    amountKobo: want.amountKobo,
  })
  if (made === null) return null
  const recorded = await service.rpc('register_flutterwave_plan', {
    p_plan_code: planCode,
    p_test_mode: settings.testMode,
    p_api_host: settings.apiHost,
    p_amount_kobo: want.amountKobo,
    p_flutterwave_plan_id: made,
  })
  const id = (recorded.data as { ok?: boolean; flutterwavePlanId?: number } | null)
    ?.flutterwavePlanId
  if (recorded.error || typeof id !== 'number') {
    logger.error({ planCode, code: recorded.error?.code }, 'plan object not recorded')
    return null
  }
  return id
}
