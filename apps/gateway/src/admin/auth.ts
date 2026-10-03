import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

/**
 * The admin routes' second door (docs/ADMIN-SPEC.md §4.1). The shared
 * gateway secret already stands in front; this adds the admin secret, and
 * names the audit note and the admin it belongs to. Neither secret alone
 * reaches anything: every route then claims its note in the database
 * (admin_claim_note) before it calls anyone (D22).
 */

export type AdminCaller = { auditId: number; label: string }

export type AdminVariables = { adminCaller: AdminCaller }

const AUDIT_ID = /^\d{1,19}$/
const LABEL = /^[a-z][a-z0-9_-]{1,30}$/

function sameSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function requireAdminCaller(
  secret: string | undefined,
): MiddlewareHandler<{ Variables: AdminVariables }> {
  return async (c, next) => {
    if (!secret) {
      return c.json(
        { ok: false, code: 'ADMIN_DISABLED', message: 'Admin routes are not configured' },
        503,
      )
    }
    if (!sameSecret(c.req.header('x-admin-secret') ?? '', secret)) {
      // Its own code: the likeliest cause is the dashboard's and the gateway's
      // admin secrets differing (DEPLOY §6b), never DomainNameAPI's credentials.
      return c.json({ ok: false, code: 'ADMIN_AUTH', message: 'Unauthorised' }, 401)
    }
    const auditId = c.req.header('x-admin-audit-id') ?? ''
    const label = c.req.header('x-admin-label') ?? ''
    if (!AUDIT_ID.test(auditId) || !LABEL.test(label)) {
      return c.json(
        {
          ok: false,
          code: 'VALIDATION_FAILED',
          message: 'An audit note and an admin are required',
        },
        400,
      )
    }
    const parsed = Number(auditId)
    if (!Number.isSafeInteger(parsed)) {
      return c.json({ ok: false, code: 'VALIDATION_FAILED', message: 'Bad audit note' }, 400)
    }
    c.set('adminCaller', { auditId: parsed, label })
    await next()
    return undefined
  }
}
