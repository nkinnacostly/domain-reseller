'use server'

import { revalidatePath } from 'next/cache'
import { accountAction, authAction } from '@/lib/safe-action'
import { asAnswer, resultMessage } from '../lib/results'
import { onboardingSchema, switchAccountSchema, updateProfileSchema } from '../schemas'
import { rememberAccount } from './remember'

/**
 * Creating and switching accounts, and editing one's profile (MAIL-SPEC
 * §7.1, §7.2, §10). SQL decides each (migrations 43, 46): who may, the limit
 * of accounts a person owns, the sandbox a new account starts in.
 */

type Failure = { error: string }

/**
 * The form then loads the dashboard afresh (`window.location`): the router may
 * still hold the dashboard as it was before the account existed — a redirect
 * to onboarding — and must not replay it.
 */
export const createAccount = authAction
  .inputSchema(onboardingSchema)
  .action(async ({ parsedInput, ctx }): Promise<Failure | { ok: true }> => {
    const { data, error } = await ctx.supabase.rpc('create_account', {
      p_name: parsedInput.name,
      p_website: parsedInput.website,
      p_use_case: parsedInput.useCase,
      p_expected_monthly_volume: parsedInput.expectedMonthlyVolume,
    })
    if (error) throw new Error(`create_account failed: ${error.code ?? 'unknown'}`)
    const answer = asAnswer(data)
    if (answer?.ok !== true || typeof answer.accountId !== 'string') {
      return { error: resultMessage(answer) }
    }
    await rememberAccount(answer.accountId)
    revalidatePath('/dashboard', 'layout')
    return { ok: true }
  })

export const switchAccount = accountAction(switchAccountSchema).action(
  async ({ ctx }): Promise<{ ok: true }> => {
    await rememberAccount(ctx.account.id)
    revalidatePath('/dashboard', 'layout')
    return { ok: true }
  },
)

export const updateProfile = accountAction(updateProfileSchema, ['owner', 'admin']).action(
  async ({ parsedInput, ctx }): Promise<Failure | { ok: true; changed: number }> => {
    const { data, error } = await ctx.supabase.rpc('update_account_profile', {
      p_account_id: ctx.account.id,
      p_name: parsedInput.name,
      p_website: parsedInput.website,
      p_use_case: parsedInput.useCase,
      p_expected_monthly_volume: parsedInput.expectedMonthlyVolume,
    })
    if (error) throw new Error(`update_account_profile failed: ${error.code ?? 'unknown'}`)
    const answer = asAnswer(data)
    if (answer?.ok !== true) return { error: resultMessage(answer) }
    revalidatePath('/dashboard', 'layout')
    return { ok: true, changed: Array.isArray(answer.changed) ? answer.changed.length : 0 }
  },
)
