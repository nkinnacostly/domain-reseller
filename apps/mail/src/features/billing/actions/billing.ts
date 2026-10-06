'use server'

import { revalidatePath } from 'next/cache'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { accountAction } from '@/lib/safe-action'
import { createServiceClient } from '@/lib/supabase/service'
import { liveSubscription, readBillingOverview } from '../lib/overview'
import { NOT_CHARGED, refusalMessage } from '../lib/words'
import { keepPlanSchema, scheduleChangeSchema, startCheckoutSchema } from '../schemas'
import { paymentsConfigured, requireBillingEnv } from '../server/env'
import { createPaymentLink } from '../server/flutterwave'
import { ensureFlutterwavePlan } from '../server/plans'
import { readProviderState, restartAndNote, stopAndNote } from '../server/provider'

/**
 * Changing plan (MAIL-SPEC §8; migration 50). Owners and admins only, here
 * and again in SQL. Every amount is SQL's; the browser sends only the plan
 * and the total it was shown, so a stale page starts nothing.
 *
 *   startCheckout  — subscribe, upgrade at once, or pay what is due: a
 *                    checkout in SQL, then Flutterwave's hosted page.
 *   scheduleChange — a smaller plan or Free at the period's end: Flutterwave
 *                    stops charging first, then SQL schedules it.
 *   keepPlan       — withdraws it: Flutterwave charges again, then SQL clears it.
 */

type Failure = { error: string }

const BILLING_PAGE = '/dashboard/billing'
const NOT_ON_SALE = 'Paid plans are not on sale yet. This account stays on its current plan.'
const PROVIDER_DOWN =
  'We could not confirm the change with Flutterwave, our payment provider. Nothing was changed. Try again in a minute.'

const MANAGERS = ['owner', 'admin'] as const

export const startCheckout = accountAction(startCheckoutSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | { redirectTo: string }> => {
    if (!paymentsConfigured()) return { error: NOT_ON_SALE }
    const settings = requireBillingEnv()
    const service = createServiceClient()
    const accountId = ctx.account.id

    // A past-due plan's Flutterwave subscription may still retry the card:
    // stop it before a new payment, or both could charge (SQL insists).
    const state = await readProviderState(service, accountId)
    if (state === 'error') return { error: refusalMessage(null) }
    if (state?.status === 'past_due' && state.firstTransactionId && !state.providerCanceled) {
      if (!(await stopAndNote(service, settings, accountId, state.firstTransactionId))) {
        return { error: `${PROVIDER_DOWN} ${NOT_CHARGED}` }
      }
    }

    const flutterwavePlanId = await ensureFlutterwavePlan(service, settings, parsedInput.planCode)
    if (flutterwavePlanId === null) return { error: refusalMessage('no_flutterwave_plan') }

    const { data, error } = await ctx.supabase.rpc('start_checkout', {
      p_account_id: accountId,
      p_plan_code: parsedInput.planCode,
      p_test_mode: settings.testMode,
      p_flutterwave_plan_id: flutterwavePlanId,
      p_expected_total_kobo: parsedInput.expectedTotalKobo,
    })
    if (error) throw new Error(`start_checkout failed: ${error.code ?? 'unknown'}`)
    const answer = data as {
      ok?: boolean
      code?: string
      checkoutId?: string
      txRef?: string
      planName?: string
      totalKobo?: number
    } | null
    if (
      answer?.ok !== true ||
      !answer.checkoutId ||
      !answer.txRef ||
      typeof answer.totalKobo !== 'number'
    ) {
      return { error: refusalMessage(answer?.code) }
    }

    const { data: account } = await ctx.supabase
      .from('accounts')
      .select('name')
      .eq('id', accountId)
      .maybeSingle()
    const fullName = String(ctx.user.user_metadata?.full_name ?? '').trim()
    const redirectUrl = new URL(`${BILLING_PAGE}/complete`, env.NEXT_PUBLIC_MAIL_URL)
    redirectUrl.searchParams.set('checkout', answer.checkoutId)
    const link = await createPaymentLink(settings, {
      txRef: answer.txRef,
      amountKobo: answer.totalKobo,
      flutterwavePlanId,
      redirectUrl: redirectUrl.toString(),
      customer: { email: ctx.user.email ?? '', name: fullName || account?.name || 'Mail customer' },
      description: `${answer.planName ?? 'Plan'} plan, monthly`,
    })
    if (!link) {
      logger.error({ checkoutId: answer.checkoutId }, 'could not start the payment')
      return {
        error: `We could not reach Flutterwave, our payment provider. ${NOT_CHARGED} Try again in a moment.`,
      }
    }
    return { redirectTo: link }
  },
)

export const scheduleChange = accountAction(scheduleChangeSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | { ok: true }> => {
    if (!paymentsConfigured()) return { error: NOT_ON_SALE }
    const settings = requireBillingEnv()
    const accountId = ctx.account.id

    // Asked first, so the card is never stopped for a change SQL would refuse.
    const { data: read, error: readError } = await ctx.supabase.rpc('billing_overview', {
      p_account_id: accountId,
    })
    const overview = readError ? null : readBillingOverview(read)
    if (!overview) return { error: refusalMessage(null) }
    const option = overview.plans.find((plan) => plan.code === parsedInput.planCode)
    const change = option?.quote.change
    if (change !== 'downgrade' && change !== 'cancel') {
      return {
        error: refusalMessage(
          change === 'current'
            ? 'current_plan'
            : change === 'upgrade'
              ? 'use_checkout'
              : 'not_offered',
        ),
      }
    }
    const live = liveSubscription(overview)
    if (live?.status === 'past_due') return { error: refusalMessage('past_due') }

    const service = createServiceClient()
    const state = await readProviderState(service, accountId)
    if (state === 'error' || !state)
      return { error: refusalMessage(state ? null : 'no_subscription') }
    const stopped = Boolean(state.firstTransactionId && !state.providerCanceled)
    if (state.firstTransactionId && stopped) {
      if (!(await stopAndNote(service, settings, accountId, state.firstTransactionId))) {
        return { error: PROVIDER_DOWN }
      }
    }

    const { data, error } = await ctx.supabase.rpc('schedule_plan_change', {
      p_account_id: accountId,
      p_plan_code: parsedInput.planCode,
    })
    const answer = error ? null : (data as { ok?: boolean; code?: string } | null)
    if (answer?.ok !== true) {
      // Not scheduled after all: the card is charged for this plan again, as before.
      if (state.firstTransactionId && stopped) {
        await restartAndNote(service, settings, accountId, state.firstTransactionId)
      }
      if (error) throw new Error(`schedule_plan_change failed: ${error.code ?? 'unknown'}`)
      return { error: refusalMessage(answer?.code) }
    }
    revalidatePath(BILLING_PAGE)
    return { ok: true }
  },
)

export const keepPlan = accountAction(keepPlanSchema, MANAGERS).action(
  async ({ ctx }): Promise<Failure | { ok: true }> => {
    if (!paymentsConfigured()) return { error: NOT_ON_SALE }
    const settings = requireBillingEnv()
    const accountId = ctx.account.id
    const service = createServiceClient()

    const state = await readProviderState(service, accountId)
    if (state === 'error') return { error: refusalMessage(null) }
    if (!state?.scheduledPlanCode) return { error: refusalMessage('nothing_scheduled') }
    if (state.firstTransactionId && state.providerCanceled) {
      if (!(await restartAndNote(service, settings, accountId, state.firstTransactionId))) {
        return { error: PROVIDER_DOWN }
      }
    }

    const { data, error } = await ctx.supabase.rpc('keep_current_plan', { p_account_id: accountId })
    if (error) throw new Error(`keep_current_plan failed: ${error.code ?? 'unknown'}`)
    const answer = data as { ok?: boolean; code?: string } | null
    if (answer?.ok !== true) return { error: refusalMessage(answer?.code) }
    revalidatePath(BILLING_PAGE)
    return { ok: true }
  },
)
