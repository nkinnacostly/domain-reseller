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
  ADMIN_ACTIONS,
  type AdminActionId,
  rank,
} from '@/features/admin/lib/actions'
import { AdminRefusal } from '@/features/admin/lib/errors'
import { type AdminPrincipal, adminWhoami } from '@/features/admin/queries/session'
import {
  describeHold,
  hasFreshSecondFactor,
  resetHoldUntil,
  SENSITIVE_CHANGE_NEEDS_TWO_FACTOR,
} from '@/features/auth/lib/security'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * Server Action clients.
 *
 * `actionClient`  — unauthenticated (search, public lookups)
 * `authAction`    — requires a signed-in user
 * `elevatedAction`— requires AAL2 (2FA verified this session) for sensitive
 *                   operations: registrant change, transfer-lock off, auth-code
 *                   reveal, nameserver change, wallet withdrawal (PRD SEC-2)
 * `adminAction`, `adminMoneyAction` — the admin dashboard (ADR-006,
 *                   docs/ADMIN-SPEC.md §2.4)
 */

function handleServerError(error: Error) {
  if (error instanceof AppError) return error.message
  logger.error({ err: error }, 'unhandled server action error')
  return 'Something went wrong on our end. Please try again.'
}

export const actionClient = createSafeActionClient({ handleServerError }).use(async ({ next }) => {
  const requestHeaders = await headers()
  return next({ ctx: { requestId: requestHeaders.get('x-request-id') ?? crypto.randomUUID() } })
})

export const authAction = actionClient.use(async ({ next }) => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.')

  return next({ ctx: { user, supabase } })
})

/**
 * Sensitive operations (PRD FR-A3, FR-A6, SEC-2, SEC-3): registrant change,
 * transfer-lock off, auth-code reveal, nameserver change, wallet withdrawal.
 * Needs a second factor verified in the last 15 minutes, and no post-reset hold.
 */
export const elevatedAction = authAction.use(async ({ next, ctx }) => {
  const [{ data: aal }, { data: profile }] = await Promise.all([
    ctx.supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ctx.supabase.from('profiles').select('password_reset_at').eq('id', ctx.user.id).single(),
  ])

  // No verified authenticator at all: asking for its code would send them to
  // a code screen with nothing to enter. Say what is missing instead (SEC-2).
  if (aal?.nextLevel === 'aal1') {
    throw new AppError('MFA_REQUIRED', SENSITIVE_CHANGE_NEEDS_TWO_FACTOR)
  }

  const now = new Date()
  if (
    aal?.currentLevel !== 'aal2' ||
    !hasFreshSecondFactor(aal.currentAuthenticationMethods ?? [], now)
  ) {
    throw new AppError(
      'MFA_REQUIRED',
      "Confirm it's you with the code from your authenticator app to continue.",
    )
  }

  const hold = resetHoldUntil(profile?.password_reset_at ?? null, now)
  if (hold) throw new AppError('FORBIDDEN', describeHold(hold))

  return next({ ctx })
})

// ── Admin (ADR-006) ─────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every admin action names its action id, so the tier, the audit row and the
 * role check agree on what is being done. The request id is a uuid: it is
 * written into the audit row (§2.5), so nothing else is accepted from a header.
 */
const adminMetadata = z.object({ action: z.enum(ADMIN_ACTION_IDS) })

const adminBase = createSafeActionClient({
  defineMetadataSchema: () => adminMetadata,
  handleServerError,
}).use(async ({ next }) => {
  const sent = (await headers()).get('x-request-id')
  return next({ ctx: { requestId: sent && UUID.test(sent) ? sent : crypto.randomUUID() } })
})

/** The six digits typed into a money dialog (D6). */
const moneyCode = z.object({ code: z.string().regex(/^\d{6}$/) })

type SessionClient = Awaited<ReturnType<typeof createClient>>

/** What an admin action's body receives. `db` is the session client: RLS and the wrappers apply. */
export type AdminContext = {
  requestId: string
  user: User
  db: SessionClient
  admin: AdminPrincipal
  action: AdminActionId
}

/**
 * The client an admin action is built on, typed for its schema. (Written out
 * because `useValidated` cannot be typed over a generic schema.)
 */
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

async function openAdmin(action: AdminActionId, requestId: string, freshMinutes: number | null) {
  const db = await createClient({ requestId })
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.')
  const admin = await adminWhoami(db, freshMinutes)
  // The web's role check is for the words only: SQL decides (admin_gate).
  if (action !== 'side.switch' && rank(admin.role) < rank(ADMIN_ACTIONS[action].minRole)) {
    throw new AdminRefusal('role')
  }
  return { user, db, admin }
}

/**
 * A standard admin action. Its input is validated first: `useValidated`
 * runs after validation, so no audit note, gateway call or target id comes
 * from unvalidated input.
 *
 * ```ts
 * export const requeueEmail = adminAction('email.requeue', schema).action(async ({ parsedInput, ctx }) => …)
 * ```
 */
export function adminAction<S extends z.ZodType>(
  action: AdminActionId,
  schema: S,
): AdminActionClient<S> {
  // A money action without its code would reach SQL and be refused there:
  // that is a programming error, caught here first.
  if (ADMIN_ACTIONS[action].money) throw new Error(`money action ${action} on adminAction`)
  return adminBase
    .metadata({ action })
    .inputSchema(schema as z.ZodType)
    .useValidated(async ({ next, metadata, ctx }) => {
      const opened = await openAdmin(metadata.action, ctx.requestId, null)
      return next({ ctx: { ...opened, action: metadata.action } })
    }) as unknown as AdminActionClient<S>
}

/**
 * A money action (D6): the input carries the six-digit code from the dialog.
 * After validation the code is verified against this session's own factor —
 * which refreshes the session — and only then does SQL see the request, with
 * a code no older than five minutes. A wrong code reaches no wrapper.
 */
export function adminMoneyAction<S extends z.ZodType<{ code: string }>>(
  action: AdminActionId,
  schema: S,
): AdminActionClient<S> {
  return adminBase
    .metadata({ action })
    .inputSchema(schema as z.ZodType)
    .useValidated(async ({ next, metadata, ctx, parsedInput }) => {
      const typed = moneyCode.safeParse(parsedInput)
      if (!typed.success) throw new AdminRefusal('WRONG_CODE')
      const { code } = typed.data
      const first = await openAdmin(metadata.action, ctx.requestId, null)
      const { error } = await first.db.auth.mfa.challengeAndVerify({
        factorId: first.admin.factorId,
        code,
      })
      if (error) throw new AdminRefusal('WRONG_CODE')
      const admin = await adminWhoami(first.db, 5)
      return next({ ctx: { user: first.user, db: first.db, admin, action: metadata.action } })
    }) as unknown as AdminActionClient<S>
}
