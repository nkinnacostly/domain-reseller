import 'server-only'

import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { cache } from 'react'
import { z } from 'zod'
import type { AdminRole } from '@/features/admin/lib/actions'
import { AdminRefusal, adminAccessError } from '@/features/admin/lib/errors'
import { type AdminSide, SIDE_COOKIE, sideFor } from '@/features/admin/lib/side'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Who the admin is, and the only way admin code reads tables (ADR-006,
 * docs/ADMIN-SPEC.md §2.3). Admins are a table checked in SQL on every
 * request: this file asks `admin_whoami`, never a claim. The service client
 * lives here and nowhere else under features/admin — CI holds that line.
 */

export type { AdminRole, AdminSide }

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

/** Principals this module issued from an `admin_whoami` answer. */
const issued = new WeakSet<object>()

const whoamiSchema = z.object({
  userId: z.uuid(),
  label: z.string().min(1),
  role: z.enum(['owner', 'operator', 'viewer']),
  testOnly: z.boolean(),
  sessionHash: z.string().regex(/^[0-9a-f]{64}$/),
  factorId: z.uuid(),
  codeAt: z.string().min(1),
})

type SessionClient = Awaited<ReturnType<typeof createClient>>

/**
 * Asks SQL who this session's admin is. `freshMinutes` is how recent the
 * session's code must be (`null`: the 12-hour admin session). Throws the
 * refusal in words; a principal comes only from a real answer.
 */
export async function adminWhoami(
  supabase: SessionClient,
  freshMinutes: number | null,
): Promise<AdminPrincipal> {
  const { data, error } = await supabase.rpc(
    'admin_whoami',
    freshMinutes === null ? {} : { p_fresh_minutes: freshMinutes },
  )
  if (error) throw adminAccessError(error.message)
  const parsed = whoamiSchema.safeParse(data)
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues.length },
      'admin_whoami answered an unexpected shape',
    )
    throw new AdminRefusal('not_admin')
  }
  const principal = Object.freeze({ ...parsed.data }) as AdminPrincipal
  issued.add(principal)
  return principal
}

/** True only for a principal this module issued. */
export function isAdminPrincipal(value: unknown): value is AdminPrincipal {
  return typeof value === 'object' && value !== null && issued.has(value)
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

/**
 * The admin, or null — for the sidebar, which renders beside AdminGate's
 * explanation of a weak sign-in and so must not turn the page into a 404.
 */
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

export type AdminSessionStatus =
  | 'ok'
  | 'needs_code'
  | 'factor_mismatch'
  | 'weak_sign_in'
  | 'not_admin'

const STATUSES = new Set<AdminSessionStatus>([
  'ok',
  'needs_code',
  'factor_mismatch',
  'weak_sign_in',
  'not_admin',
])

/** The gate's word for this session, once per request; never an error. */
export const adminSessionStatus = cache(async (): Promise<AdminSessionStatus> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return 'not_admin'
  const { data, error } = await supabase.rpc('admin_status')
  if (error || typeof data !== 'string' || !STATUSES.has(data as AdminSessionStatus)) {
    return 'not_admin'
  }
  return data as AdminSessionStatus
})

/**
 * The admin layout's first step, before any admin chrome: a stranger gets the
 * not-found page here, with no sidebar and no admin title, even if the proxy
 * never ran for this path (§2.3). Only the proxy can make the status a 404 —
 * the page's static shell has gone out by now. Anyone else goes on to
 * AdminGate, which explains or lets them in.
 */
export async function assertAdminArea(): Promise<AdminSessionStatus> {
  const status = await adminSessionStatus()
  if (status === 'not_admin') notFound()
  return status
}

/** Live or Test from the cookie; a test admin is always on the test side (D15). */
export async function getAdminSide(admin: AdminPrincipal): Promise<AdminSide> {
  const store = await cookies()
  return sideFor(admin, store.get(SIDE_COOKIE)?.value)
}

// ── adminDb: select only, over a fixed map, with the side applied ─────────

type Service = ReturnType<typeof createServiceClient>

/**
 * How the side is applied to a table:
 * - `test_mode`: its own column;
 * - `environment`: `supplier_calls`, `ote` or `production`;
 * - `parent`: an inner embed of the parent's `test_mode`, under `admin_side`;
 * - `live_only`: rows that exist only on the live side (`float_topups`);
 * - `test_actor`: `admin_audit_log`, the test admin's own kind of rows;
 * - `global`: no filter.
 */
type SideRule =
  | { kind: 'test_mode' }
  | { kind: 'environment' }
  | { kind: 'parent'; embed: string; column: string }
  | { kind: 'live_only' }
  | { kind: 'test_actor' }
  | { kind: 'global'; publicSafe: boolean }

type Entry = Readonly<{ side: SideRule; from: (db: Service) => unknown }>

const TEST_MODE = { kind: 'test_mode' } as const
const GLOBAL = { kind: 'global', publicSafe: false } as const
const PUBLIC = { kind: 'global', publicSafe: true } as const

/**
 * Every table and view admin pages may read (§2.3). Never here: profiles,
 * payments, email_outbox, compliance_notices, ssl_certificates, domains,
 * transfer_secrets, admins, admin_changes — their rows come through the
 * masked views or the admin_* functions.
 */
export const ADMIN_TABLES = {
  orders: { side: TEST_MODE, from: (db: Service) => db.from('orders') },
  order_items: {
    side: {
      kind: 'parent',
      embed: 'admin_side:orders!inner(test_mode)',
      column: 'admin_side.test_mode',
    },
    from: (db: Service) => db.from('order_items'),
  },
  order_item_costs: {
    side: {
      kind: 'parent',
      embed: 'admin_side:order_items!inner(orders!inner(test_mode))',
      column: 'admin_side.orders.test_mode',
    },
    from: (db: Service) => db.from('order_item_costs'),
  },
  refunds: { side: TEST_MODE, from: (db: Service) => db.from('refunds') },
  refund_events: {
    side: {
      kind: 'parent',
      embed: 'admin_side:refunds!inner(test_mode)',
      column: 'admin_side.test_mode',
    },
    from: (db: Service) => db.from('refund_events'),
  },
  payment_incidents: { side: TEST_MODE, from: (db: Service) => db.from('payment_incidents') },
  jobs: { side: TEST_MODE, from: (db: Service) => db.from('jobs') },
  ssl_jobs: { side: TEST_MODE, from: (db: Service) => db.from('ssl_jobs') },
  supplier_calls: {
    side: { kind: 'environment' },
    from: (db: Service) => db.from('supplier_calls'),
  },
  domain_events: {
    side: {
      kind: 'parent',
      embed: 'admin_side:domains!inner(test_mode)',
      column: 'admin_side.test_mode',
    },
    from: (db: Service) => db.from('domain_events'),
  },
  domain_nameserver_history: {
    side: {
      kind: 'parent',
      embed: 'admin_side:domains!inner(test_mode)',
      column: 'admin_side.test_mode',
    },
    from: (db: Service) => db.from('domain_nameserver_history'),
  },
  registry_drift: { side: TEST_MODE, from: (db: Service) => db.from('registry_drift') },
  reconcile_runs: { side: TEST_MODE, from: (db: Service) => db.from('reconcile_runs') },
  ops_alerts: { side: TEST_MODE, from: (db: Service) => db.from('ops_alerts') },
  supplier_ledger_entries: {
    side: TEST_MODE,
    from: (db: Service) => db.from('supplier_ledger_entries'),
  },
  supplier_ledger_revisions: {
    side: TEST_MODE,
    from: (db: Service) => db.from('supplier_ledger_revisions'),
  },
  supplier_balance_snapshots: {
    side: TEST_MODE,
    from: (db: Service) => db.from('supplier_balance_snapshots'),
  },
  float_topups: { side: { kind: 'live_only' }, from: (db: Service) => db.from('float_topups') },
  metrics_daily: { side: TEST_MODE, from: (db: Service) => db.from('metrics_daily') },
  funnel_daily: { side: TEST_MODE, from: (db: Service) => db.from('funnel_daily') },
  admin_audit_log: {
    side: { kind: 'test_actor' },
    from: (db: Service) => db.from('admin_audit_log'),
  },
  admin_payments_v: { side: TEST_MODE, from: (db: Service) => db.from('admin_payments_v') },
  admin_domains_v: { side: TEST_MODE, from: (db: Service) => db.from('admin_domains_v') },
  admin_ssl_certificates_v: {
    side: TEST_MODE,
    from: (db: Service) => db.from('admin_ssl_certificates_v'),
  },
  admin_email_outbox_v: { side: TEST_MODE, from: (db: Service) => db.from('admin_email_outbox_v') },
  admin_compliance_notices_v: {
    side: TEST_MODE,
    from: (db: Service) => db.from('admin_compliance_notices_v'),
  },
  tlds: { side: PUBLIC, from: (db: Service) => db.from('tlds') },
  ssl_products: { side: PUBLIC, from: (db: Service) => db.from('ssl_products') },
  nameserver_presets: { side: PUBLIC, from: (db: Service) => db.from('nameserver_presets') },
  nameserver_preset_drafts: {
    side: GLOBAL,
    from: (db: Service) => db.from('nameserver_preset_drafts'),
  },
  fx_rates: { side: PUBLIC, from: (db: Service) => db.from('fx_rates') },
  pricing_settings: { side: PUBLIC, from: (db: Service) => db.from('pricing_settings') },
  ops_settings: { side: GLOBAL, from: (db: Service) => db.from('ops_settings') },
  service_heartbeats: { side: GLOBAL, from: (db: Service) => db.from('service_heartbeats') },
} as const satisfies Record<string, Entry>

export type AdminTableName = keyof typeof ADMIN_TABLES

type Builder<N extends AdminTableName> = ReturnType<(typeof ADMIN_TABLES)[N]['from']>

export type SelectOptions = { head?: boolean; count?: 'exact' | 'planned' | 'estimated' }

/**
 * Select, and nothing else: no insert, update, delete, upsert or rpc. Name
 * the columns; a parent-filtered table also returns `admin_side`.
 */
export type AdminDb = {
  from<N extends AdminTableName>(name: N): { select: Builder<N>['select'] }
}

// biome-ignore lint/suspicious/noExplicitAny: the builder's own generics are restored by AdminDb's type
type AnyBuilder = any

function applySide(query: AnyBuilder, rule: SideRule, side: AdminSide, admin: AdminPrincipal) {
  switch (rule.kind) {
    case 'test_mode':
      return query.eq('test_mode', side === 'test')
    case 'environment':
      return query.eq('environment', side === 'test' ? 'ote' : 'production')
    case 'parent':
      return query.eq(rule.column, side === 'test')
    case 'live_only':
      // No test-side rows exist; an empty `in` returns none.
      return side === 'test' ? query.in('id', []) : query
    case 'test_actor':
      return admin.testOnly ? query.eq('test_actor', true) : query
    case 'global':
      return query
  }
}

/**
 * Select-only reads over `ADMIN_TABLES`, with the side filter applied before
 * the builder is handed back (§2.3). RLS does not apply to the service
 * client: this map and the filter are the control.
 */
export function adminDb(admin: AdminPrincipal, side: AdminSide): AdminDb {
  if (!isAdminPrincipal(admin)) throw new AdminRefusal('not_admin')
  const effective: AdminSide = admin.testOnly ? 'test' : side
  let service: Service | null = null
  const db = () => {
    service ??= createServiceClient()
    return service
  }

  return {
    from(name) {
      const entry: Entry | undefined = (ADMIN_TABLES as Record<string, Entry>)[name]
      if (!entry || !Object.hasOwn(ADMIN_TABLES, name)) throw new Error('not an admin table')
      if (admin.testOnly && entry.side.kind === 'global' && !entry.side.publicSafe) {
        throw new AdminRefusal('TEST_ADMIN')
      }
      const select = (columns: string, options?: SelectOptions) => {
        const rule = entry.side
        const list = rule.kind === 'parent' ? `${columns}, ${rule.embed}` : columns
        const builder = (entry.from(db()) as AnyBuilder).select(list, options)
        return applySide(builder, rule, effective, admin)
      }
      return { select } as AnyBuilder
    },
  }
}
