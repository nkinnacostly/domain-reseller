'use server'

import { createSesManager } from '@dr/shared/ses'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireSesManagerEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { accountAction } from '@/lib/safe-action'
import {
  SES_REFUSED,
  SES_UNAVAILABLE,
  SUPPRESSION_FALLBACK,
  suppressionRefusal,
} from '../lib/words'

/**
 * Removing an address from the account's suppression list (MAIL-SPEC §7.5,
 * §10; migration 49). The list mirrors the account's SES tenant's, so SES's
 * copy goes first, with the manager key (§4.3: it may manage suppression,
 * never send): only once SES has let the address go does ours, so we never
 * say "removed" while SES would still drop the email. SES matches the case
 * an address was sent in, so each form we know of is removed. A test account
 * (`is_e2e`) has no real tenant and never reaches SES (migration 45's rule).
 * Owners and admins only; SQL checks again. The address is never logged.
 */

const schema = z.object({
  accountId: z.uuid(),
  suppressionId: z.number().int().positive(),
})

type Failure = { error: string }

export const removeSuppression = accountAction(schema, ['owner', 'admin']).action(
  async ({ parsedInput, ctx }): Promise<Failure | { ok: true }> => {
    const [{ data: row, error: rowError }, { data: account, error: accountError }] =
      await Promise.all([
        ctx.supabase
          .from('suppressions')
          .select('id, address, ses_address')
          .eq('id', parsedInput.suppressionId)
          .eq('account_id', ctx.account.id)
          .maybeSingle(),
        ctx.supabase
          .from('accounts')
          .select('ses_tenant, tenant_ready_at, is_e2e')
          .eq('id', ctx.account.id)
          .maybeSingle(),
      ])
    if (rowError || accountError) {
      throw new Error(
        `suppression could not be read: ${(rowError ?? accountError)?.code ?? 'unknown'}`,
      )
    }
    if (!row || !account) return { error: suppressionRefusal({ code: 'not_found' }) }

    if (!account.is_e2e && account.tenant_ready_at) {
      let ses: ReturnType<typeof createSesManager>
      try {
        ses = createSesManager(requireSesManagerEnv())
      } catch {
        logger.error(
          { suppressionId: row.id },
          'suppressions: the SES manager key is not configured',
        )
        return { error: SES_UNAVAILABLE }
      }
      const forms = [...new Set([row.ses_address, row.address].filter((a): a is string => !!a))]
      for (const address of forms) {
        const answer = await ses.deleteSuppressedDestination(address, account.ses_tenant)
        if (!answer.ok) {
          logger.warn(
            { suppressionId: row.id, status: answer.status, code: answer.code },
            'suppressions: SES did not remove the address',
          )
          return { error: SES_REFUSED }
        }
      }
    }

    const { data, error } = await ctx.supabase.rpc('remove_suppression', {
      p_suppression_id: row.id,
    })
    if (error) throw new Error(`remove_suppression failed: ${error.code ?? 'unknown'}`)
    const answer = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
    if (answer?.ok !== true)
      return { error: answer ? suppressionRefusal(answer) : SUPPRESSION_FALLBACK }
    revalidatePath('/dashboard/suppressions')
    return { ok: true }
  },
)
