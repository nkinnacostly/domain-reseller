import 'server-only'

import { AppError } from '@dr/shared/errors'
import type { User } from '@supabase/supabase-js'
import { headers } from 'next/headers'
import {
  createSafeActionClient,
  type SafeActionClient,
  type ValidationErrors,
} from 'next-safe-action'
import { z } from 'zod'
import {
  ADMIN_ACTION_IDS,
  type AdminActionId,
  MAIL_ADMIN_TIERS,
  rank,
} from '@/features/admin/lib/actions'
import { AdminRefusal, SERVER_CRASH_WORDS } from '@/features/admin/lib/errors'
import { type AdminPrincipal, adminWhoami } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'
import { createClient, type MailSessionClient } from '@/lib/supabase/server'

/**
 * Mail's admin action clients, the shop's `adminAction` and
 * `adminMoneyAction` (CLAUDE.md §8, ADMIN-SPEC §2.4) on Mail's session
 * client. Input is validated first; then `admin_whoami` (the admins table, in
 * SQL) and the role — the web's check only words a refusal early: every
 * `admin_mail_*` wrapper applies admin_tier itself. A money action's input
 * carries the dialog's six-digit code, verified against this session's own
 * factor before any wrapper is called (D6, MR5).
 */

function handleServerError(error: Error) {
  if (error instanceof AppError) return error.message
  logger.error({ err: error.message }, 'unhandled admin action error')
  return SERVER_CRASH_WORDS
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const adminMetadata = z.object({ action: z.enum(ADMIN_ACTION_IDS) })

const adminBase = createSafeActionClient({
  defineMetadataSchema: () => adminMetadata,
  handleServerError,
}).use(async ({ next }) => {
  const sent = (await headers()).get('x-request-id')
  return next({ ctx: { requestId: sent && UUID.test(sent) ? sent : crypto.randomUUID() } })
})

/** What an admin action's body receives. `db` is the session client: the wrappers apply. */
export type AdminContext = {
  requestId: string
  user: User
  db: MailSessionClient
  admin: AdminPrincipal
  action: AdminActionId
}

export type AdminActionClient<S extends z.ZodType> = SafeActionClient<
  string,
  undefined,
  typeof adminMetadata,
  z.output<typeof adminMetadata>,
  true,
  AdminContext,
  undefined,
  S,
  undefined,
  readonly [],
  ValidationErrors<S>,
  false,
  true,
  { requestId: string }
>

async function openAdmin(action: AdminActionId, freshMinutes: number | null) {
  const db = await createClient()
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.')
  const admin = await adminWhoami(db, freshMinutes)
  if (rank(admin.role) < rank(MAIL_ADMIN_TIERS[action].minRole)) throw new AdminRefusal('role')
  return { user, db, admin }
}

/** A standard admin action (approve, reject, pause). */
export function adminAction<S extends z.ZodType>(
  action: AdminActionId,
  schema: S,
): AdminActionClient<S> {
  if (MAIL_ADMIN_TIERS[action].money) throw new Error(`money action ${action} on adminAction`)
  return adminBase
    .metadata({ action })
    .inputSchema(schema as z.ZodType)
    .useValidated(async ({ next, metadata }) => {
      const opened = await openAdmin(metadata.action, null)
      return next({ ctx: { ...opened, action: metadata.action } })
    }) as unknown as AdminActionClient<S>
}

const WRONG_CODE_ERRORS: ReadonlySet<string> = new Set([
  'mfa_verification_failed',
  'mfa_challenge_expired',
])
const RATE_LIMIT_ERRORS: ReadonlySet<string> = new Set([
  'over_request_rate_limit',
  'too_many_requests',
])

/** Why challengeAndVerify refused: each reached no wrapper, so nothing changed. */
export function codeRefusal(error: {
  code?: string | undefined
  status?: number | undefined
}): AdminRefusal {
  const code = error.code ?? ''
  if (WRONG_CODE_ERRORS.has(code)) return new AdminRefusal('WRONG_CODE')
  if (error.status === 429 || RATE_LIMIT_ERRORS.has(code)) {
    return new AdminRefusal('CODE_RATE_LIMITED')
  }
  return new AdminRefusal('CODE_NOT_CHECKED')
}

const moneyCode = z.object({ code: z.string().regex(/^\d{6}$/) })

/**
 * A money-tier action (resume, cap overrides): the code from the dialog is
 * verified against this session's factor — which refreshes the session — and
 * only then does SQL see the request, with a code no older than five minutes.
 */
export function adminMoneyAction<S extends z.ZodType<{ code: string }>>(
  action: AdminActionId,
  schema: S,
): AdminActionClient<S> {
  if (!MAIL_ADMIN_TIERS[action].money)
    throw new Error(`standard action ${action} on adminMoneyAction`)
  return adminBase
    .metadata({ action })
    .inputSchema(schema as z.ZodType)
    .useValidated(async ({ next, metadata, parsedInput }) => {
      const typed = moneyCode.safeParse(parsedInput)
      if (!typed.success) throw new AdminRefusal('WRONG_CODE')
      const first = await openAdmin(metadata.action, null)
      const { error } = await first.db.auth.mfa.challengeAndVerify({
        factorId: first.admin.factorId,
        code: typed.data.code,
      })
      if (error) throw codeRefusal(error)
      const admin = await adminWhoami(first.db, 5)
      return next({ ctx: { user: first.user, db: first.db, admin, action: metadata.action } })
    }) as unknown as AdminActionClient<S>
}
