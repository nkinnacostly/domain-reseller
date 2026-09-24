'use server'

import type { Json } from '@dr/db/types'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { parseNameservers } from '@/features/checkout/lib/nameservers'
import { logger } from '@/lib/logger'
import { LIMITS, withinLimit } from '@/lib/rate-limit'
import { authAction, elevatedAction } from '@/lib/safe-action'
import type { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { BULK_MAX, type BulkKind } from '../lib/bulk'
import { chunk, IDS_PER_READ } from '../lib/chunks'
import { judgeNameservers } from '../lib/nameserver-check'
import { guardSensitiveBulkChange } from '../queries/bulk-guard'
import { lookupHost } from '../queries/dns'

/**
 * Bulk actions (PRD FR-P4, FR-N2). One call to `start_bulk_change`
 * (migration 32) records the request and gives every domain a line: a
 * registry change is queued as a job per domain — never a loop of writes
 * here — and auto-renew and labels are applied in the same transaction.
 * The function takes the account from us, never from the browser, and
 * leaves out any domain that is not that account's.
 *
 * The security is the one-domain actions' own (SEC-2): a nameserver change
 * and turning the transfer lock off need a fresh second factor
 * (elevatedAction); the rest need a signed-in session. The nameserver set
 * is checked against live DNS once, before anything is saved (FR-D4).
 * Each sensitive change — nameservers, unlocking, privacy — asks
 * `guardSensitiveBulkChange` first, the one place account-wide rules for
 * them live.
 */

type Ctx = { supabase: Awaited<ReturnType<typeof createClient>>; user: { id: string } }

export type BulkResult =
  | { error: string; details?: string[] }
  | { ok: true; operationId: string; warnings: string[] }

const domainIds = z
  .array(z.uuid())
  .min(1, 'Choose at least one domain.')
  .max(BULK_MAX, `Choose at most ${BULK_MAX} domains at a time.`)

const FAILED = 'That change could not be started. Nothing was changed — please try again.'

async function start(
  ctx: Ctx,
  ids: readonly string[],
  kind: BulkKind,
  value: Json,
  warnings: string[] = [],
): Promise<BulkResult> {
  if (!(await withinLimit(`bulk_change:${ctx.user.id}`, LIMITS.bulkChange))) {
    return {
      error:
        'You have started several bulk changes in the last few minutes. Wait a little, then try again.',
    }
  }
  const { data, error } = await createServiceClient().rpc('start_bulk_change', {
    p_user_id: ctx.user.id,
    p_domain_ids: [...new Set(ids)],
    p_kind: kind,
    p_value: value,
  })
  if (error || !data) {
    // 22023: the function refused the request itself — a label not the account's.
    if (error?.code === '22023' && (kind === 'label' || kind === 'unlabel')) {
      return { error: 'That label is not on your account.' }
    }
    logger.error({ code: error?.code, kind, count: ids.length }, 'bulk change not started')
    return { error: FAILED }
  }
  revalidatePath('/app/domains', 'layout')
  return { ok: true, operationId: data, warnings }
}

/**
 * FR-N2 — one nameserver set for many domains. Parsed and looked up once;
 * each domain is then judged against it, because a nameserver inside a
 * domain needs glue records (FR-N3) that we cannot set.
 */
export const changeNameserversInBulk = elevatedAction
  .inputSchema(
    z.object({
      domainIds,
      nameservers: z.string().max(2000),
      presetId: z.uuid().nullable().optional(),
    }),
  )
  .action(async ({ parsedInput, ctx }): Promise<BulkResult> => {
    const refused = await guardSensitiveBulkChange(ctx)
    if (refused) return refused
    const parsed = parseNameservers(parsedInput.nameservers)
    if (!parsed.ok) return { error: parsed.error }
    if (!parsed.nameservers) return { error: 'Enter at least two nameservers.' }
    const next = parsed.nameservers

    // The names, as the user (RLS): only their own come back.
    const reads = await Promise.all(
      chunk([...new Set(parsedInput.domainIds)], IDS_PER_READ).map((ids) =>
        ctx.supabase.from('domains').select('id, domain_name').in('id', ids),
      ),
    )
    const failed = reads.find((read) => read.error)
    if (failed?.error) {
      logger.error({ code: failed.error.code }, 'bulk nameserver domains not read')
      return { error: FAILED }
    }
    const domains = reads.flatMap((read) => read.data ?? [])
    if (domains.length === 0) return { error: 'None of those domains are on your account.' }

    const lookups = new Map(
      await Promise.all(next.map(async (host) => [host, await lookupHost(host)] as const)),
    )
    const blocking = new Set<string>()
    const warnings = new Set<string>()
    for (const domain of domains) {
      const verdict = judgeNameservers(domain.domain_name, lookups)
      for (const reason of verdict.blocking) blocking.add(reason)
      for (const warning of verdict.warnings) warnings.add(warning)
    }
    if (blocking.size > 0) {
      return {
        error: 'Some nameservers need fixing before we can use them.',
        details: [...blocking],
      }
    }
    // N11: the function keeps the host label only for a preset customers can see.
    return start(
      ctx,
      domains.map((domain) => domain.id),
      'nameservers',
      { nameservers: next, preset_id: parsedInput.presetId ?? null },
      [...warnings],
    )
  })

/** FR-DS4: the lock goes on with a signed-in session. */
export const lockTransfersInBulk = authAction
  .inputSchema(z.object({ domainIds }))
  .action(({ parsedInput, ctx }) =>
    start(ctx, parsedInput.domainIds, 'transfer_lock', { locked: true }),
  )

/** FR-DS4, SEC-2: off is what a thief needs first — a fresh second factor. */
export const unlockTransfersInBulk = elevatedAction
  .inputSchema(z.object({ domainIds }))
  .action(async ({ parsedInput, ctx }): Promise<BulkResult> => {
    const refused = await guardSensitiveBulkChange(ctx)
    if (refused) return refused
    return start(ctx, parsedInput.domainIds, 'transfer_lock', { locked: false })
  })

/** FR-DS3: contact privacy, skipped where the extension does not offer it. */
export const setPrivacyInBulk = authAction
  .inputSchema(z.object({ domainIds, enabled: z.boolean() }))
  .action(async ({ parsedInput, ctx }): Promise<BulkResult> => {
    const refused = await guardSensitiveBulkChange(ctx)
    if (refused) return refused
    return start(ctx, parsedInput.domainIds, 'privacy', { enabled: parsedInput.enabled })
  })

/** FR-RN2: auto-renew is our own billing preference, applied at once. */
export const setAutoRenewInBulk = authAction
  .inputSchema(z.object({ domainIds, enabled: z.boolean() }))
  .action(({ parsedInput, ctx }) =>
    start(ctx, parsedInput.domainIds, 'auto_renew', { enabled: parsedInput.enabled }),
  )

/** FR-P3: one of the account's labels on, or off, many domains. */
export const labelDomainsInBulk = authAction
  .inputSchema(z.object({ domainIds, labelId: z.uuid(), on: z.boolean() }))
  .action(({ parsedInput, ctx }) =>
    start(ctx, parsedInput.domainIds, parsedInput.on ? 'label' : 'unlabel', {
      label_id: parsedInput.labelId,
    }),
  )
