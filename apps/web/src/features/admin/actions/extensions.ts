'use server'

import type { Database } from '@dr/db/types'
import { revalidateTag } from 'next/cache'
import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import { rankTakenWords } from '@/features/admin/lib/settings-copy'
import { getAdminSide } from '@/features/admin/queries/session'
import { getFeaturedRanks } from '@/features/admin/queries/settings'
import { type ExtensionChange, extensionFlagsSchema } from '@/features/admin/schemas/settings'
import { type AdminContext, adminMoneyAction } from '@/lib/safe-action'

/**
 * Pause, resume and feature an extension (docs/ADMIN-SPEC.md §3.1.2
 * `admin_set_tld_flags`, §5.2 B13): owner, money tier, the dialog's code
 * verified first (D6). SQL reads a null as "keep what is stored", so each
 * change sends only its own flag: a pause leaves the featuring alone, and
 * featuring leaves a pause and its reason. Prices on the site are cached
 * under `pricing` and a paused extension has none, so they are expired after
 * every change that went through (N5b).
 */

type TldFlagsArgs = Database['public']['Functions']['admin_set_tld_flags']['Args']

/** The wrapper's arguments. Generated types call each one required; SQL takes null as "keep". */
type FlagArgs = {
  p_name: string
  p_is_paused: boolean | null
  p_paused_reason: string | null
  p_featured_rank: number | null
  p_featured_tagline: string | null
  p_reason: string
  p_request_key: string
}

function flagArgs(name: string, change: ExtensionChange, requestKey: string): FlagArgs {
  const keep = {
    p_is_paused: null,
    p_paused_reason: null,
    p_featured_rank: null,
    p_featured_tagline: null,
  }
  switch (change.kind) {
    case 'pause':
      // The pause's own reason is the audit reason: one text, said once.
      return {
        ...keep,
        p_name: name,
        p_is_paused: true,
        p_paused_reason: change.why,
        p_reason: change.why,
        p_request_key: requestKey,
      }
    case 'resume':
      return {
        ...keep,
        p_name: name,
        p_is_paused: false,
        p_reason: change.reason,
        p_request_key: requestKey,
      }
    case 'feature':
      return {
        ...keep,
        p_name: name,
        p_featured_rank: change.rank,
        // An empty tagline removes it (§3.1.2: clearing is explicit).
        p_featured_tagline: change.tagline,
        p_reason: change.reason,
        p_request_key: requestKey,
      }
    case 'unfeature':
      return {
        ...keep,
        p_name: name,
        p_featured_rank: 0,
        p_featured_tagline: '',
        p_reason: change.reason,
        p_request_key: requestKey,
      }
  }
}

/** Postgres' unique_violation: the transaction rolled back, so nothing changed. */
const UNIQUE_VIOLATION = '23505'

/**
 * Each featured rank belongs to one extension (`tlds_featured_rank_unique`).
 * A rank another holds is refused here, in words, before SQL is asked;
 * should one be taken in between, the database refuses the whole call.
 */
async function rankRefusal(
  ctx: AdminContext,
  name: string,
  rank: number,
): Promise<AdminResult | null> {
  const ranks = await getFeaturedRanks(ctx.admin, await getAdminSide(ctx.admin))
  const holder = ranks?.find((entry) => entry.rank === rank && entry.name !== name)
  return holder ? rankTaken(rank, holder.name) : null
}

const rankTaken = (rank: number, holder: string | null): AdminResult => ({
  ok: false,
  code: 'RANK_TAKEN',
  message: rankTakenWords(rank, holder),
})

export const setExtensionFlags = adminMoneyAction('extension.flags', extensionFlagsSchema).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> => {
    const { name, change, requestKey } = parsedInput
    if (change.kind === 'feature') {
      const refused = await rankRefusal(ctx, name, change.rank)
      if (refused) return refused
    }
    const { data, error } = await ctx.db.rpc(
      'admin_set_tld_flags',
      flagArgs(name, change, requestKey) as unknown as TldFlagsArgs,
    )
    if (error) {
      if (change.kind === 'feature' && error.code === UNIQUE_VIOLATION) {
        return rankTaken(change.rank, null)
      }
      throw adminAccessError(error.message)
    }
    const result = toAdminResult(data)
    if (result.ok) revalidateTag('pricing', { expire: 0 })
    return result
  },
)
