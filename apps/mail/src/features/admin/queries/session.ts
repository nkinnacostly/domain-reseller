import 'server-only'

import { notFound, redirect } from 'next/navigation'
import { cache } from 'react'
import { z } from 'zod'
import type { AdminRole } from '@/features/admin/lib/actions'
import { AdminRefusal, adminAccessError } from '@/features/admin/lib/errors'
import { type AdminStatus, toAdminStatus } from '@/features/admin/lib/gate'
import { logger } from '@/lib/logger'
import { createClient, type MailSessionClient } from '@/lib/supabase/server'

/**
 * Who Mail's admin is (MAIL-SPEC §10, M5: the shop's admins table and gate,
 * ADR-006). Admins are a table checked in SQL on every request: this file
 * asks `admin_whoami` and `admin_status`, never a claim. Mail's admin reads
 * no table either: every read is an `admin_mail_*` function behind the same
 * gate, called with the session client — the secret key reads nothing in
 * schema `mail` (migration 44).
 */

declare const ADMIN_BRAND: unique symbol

export type AdminPrincipal = Readonly<{
  userId: string
  label: string
  role: AdminRole
  testOnly: boolean
  sessionHash: string
  factorId: string
  codeAt: string
}> & { readonly [ADMIN_BRAND]: true }

const whoamiSchema = z.object({
  userId: z.uuid(),
  label: z.string().min(1),
  role: z.enum(['owner', 'operator', 'viewer']),
  testOnly: z.boolean(),
  sessionHash: z.string().regex(/^[0-9a-f]{64}$/),
  factorId: z.uuid(),
  codeAt: z.string().min(1),
})

/**
 * Asks SQL who this session's admin is. `freshMinutes` is how recent the
 * session's code must be (`null`: the 12-hour admin session). Throws the
 * refusal in words; a principal comes only from a real answer.
 */
export async function adminWhoami(
  supabase: MailSessionClient,
  freshMinutes: number | null,
): Promise<AdminPrincipal> {
  const { data, error } = await supabase
    .schema('public')
    .rpc('admin_whoami', freshMinutes === null ? {} : { p_fresh_minutes: freshMinutes })
  if (error) throw adminAccessError(error.message)
  const parsed = whoamiSchema.safeParse(data)
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues.length },
      'admin_whoami answered an unexpected shape',
    )
    throw new AdminRefusal('not_admin')
  }
  return Object.freeze({ ...parsed.data }) as AdminPrincipal
}

/**
 * The admin for this render, once per request. No user, no admin, or any
 * refusal but a stale code is a 404: nothing tells a stranger /admin exists.
 */
export const requireAdmin = cache(async (): Promise<AdminPrincipal> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) notFound()
  try {
    return await adminWhoami(supabase, null)
  } catch (error) {
    if (error instanceof AdminRefusal && error.adminCode === 'needs_code') {
      redirect('/verify?next=/admin')
    }
    notFound()
  }
})

/** The admin, or null — for the sidebar, which renders beside the gate's explanations. */
export const findAdmin = cache(async (): Promise<AdminPrincipal | null> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  try {
    return await adminWhoami(supabase, null)
  } catch {
    return null
  }
})

/** The gate's word for this session, once per request; never an error. */
export const adminSessionStatus = cache(async (): Promise<AdminStatus> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return 'not_admin'
  const { data, error } = await supabase.schema('public').rpc('admin_status')
  return error ? 'not_admin' : toAdminStatus(data)
})

/**
 * The admin layout's first step, before any admin chrome: a stranger gets the
 * not-found page here, even if the proxy never ran for this path. Only the
 * proxy can make the status a 404 — the page's shell has gone out by now.
 */
export async function assertAdminArea(): Promise<AdminStatus> {
  const status = await adminSessionStatus()
  if (status === 'not_admin') notFound()
  return status
}
