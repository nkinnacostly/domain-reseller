import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADMIN_TABLES } from '@/features/admin/queries/session'

/**
 * The admin area's lines, checked in the source (docs/ADMIN-SPEC.md §8.1).
 * Every B package lands inside them: reads through adminDb or admin_*
 * functions, writes only through admin_* wrappers, and no select that could
 * carry personal data, a secret or a raw provider answer to a page.
 */

const SRC = join(__dirname, '../../../..')
const FEATURE = join(SRC, 'features/admin')
const ROUTES = join(SRC, 'app/(admin)')

function files(dir: string): string[] {
  let found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__') continue
      found = found.concat(files(path))
    } else if (/\.(ts|tsx)$/.test(name)) {
      found.push(path)
    }
  }
  return found
}

const ALL = [...files(FEATURE), ...files(ROUTES)].map((path) => ({
  path,
  rel: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}))

const BANNED_COLUMNS = [
  'auth_code',
  'raw',
  'csr',
  'contact',
  'contacts',
  'registrant',
  'pending_registrant',
  'pending_contacts',
  'to_email',
  'recipient',
  'approver_email',
  'delivery_detail',
  'data',
  'private_key',
  'secret',
  'key',
]

/** Every string literal passed straight to `.select(…)`. */
function selects(text: string): string[] {
  return [...text.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)].map(
    ([, , columns]) => columns as string,
  )
}

describe('admin boundaries', () => {
  it('finds the admin code it checks', () => {
    expect(ALL.some((file) => file.rel.endsWith('queries/session.ts'))).toBe(true)
    expect(ALL.some((file) => file.rel.startsWith('app/(admin)/admin/'))).toBe(true)
  })

  it('keeps every query and action on the server', () => {
    for (const file of ALL.filter((f) => /features\/admin\/(queries|actions)\//.test(f.rel))) {
      const first = file.text.trimStart().split('\n')[0]
      expect(["import 'server-only'", "'use server'"], file.rel).toContain(first)
    }
  })

  it("never selects '*'", () => {
    for (const file of ALL) {
      for (const columns of selects(file.text)) {
        expect(columns.trim(), file.rel).not.toBe('*')
        expect(columns, file.rel).not.toMatch(/(^|[\s,(])\*(\s*[,)]|\s*$)/)
      }
    }
  })

  it('selects no column that holds personal data, a secret or a raw provider answer', () => {
    for (const file of ALL) {
      for (const columns of selects(file.text)) {
        for (const banned of BANNED_COLUMNS) {
          if (banned === 'key' && file.rel.endsWith('queries/alerts.ts')) continue
          // Whole names only: idempotency_key and checked_data pass.
          const whole = new RegExp(`(^|[^a-z0-9_])${banned}([^a-z0-9_]|$)`)
          expect(whole.test(columns), `${file.rel} selects ${banned}`).toBe(false)
        }
      }
    }
  })

  it('reads only tables and views in ADMIN_TABLES', () => {
    const allowed = new Set(Object.keys(ADMIN_TABLES))
    for (const file of ALL) {
      for (const [, name] of file.text.matchAll(/\.from\(\s*['"`]([a-z_]+)['"`]/g)) {
        expect(allowed.has(name as string), `${file.rel} reads ${name}`).toBe(true)
      }
    }
  })

  it('maps exactly the tables and views §2.3 and the B packages read', () => {
    expect(Object.keys(ADMIN_TABLES).sort()).toEqual(
      [
        'admin_audit_log',
        'admin_compliance_notices_v',
        'admin_domains_v',
        'admin_email_outbox_v',
        'admin_payments_v',
        'admin_ssl_certificates_v',
        'domain_events',
        'domain_nameserver_history',
        'float_topups',
        'funnel_daily',
        'fx_rates',
        'jobs',
        'metrics_daily',
        'nameserver_preset_drafts',
        'nameserver_presets',
        'ops_alerts',
        'ops_settings',
        'order_item_costs',
        'order_items',
        'orders',
        'payment_incidents',
        'pricing_settings',
        'reconcile_runs',
        'refund_events',
        'refunds',
        'registry_drift',
        'service_heartbeats',
        'ssl_jobs',
        'ssl_products',
        'supplier_balance_snapshots',
        'supplier_calls',
        'supplier_ledger_entries',
        'supplier_ledger_revisions',
        'tlds',
      ].sort(),
    )
  })

  it('writes only through admin_* functions', () => {
    for (const file of ALL) {
      expect(file.text, file.rel).not.toMatch(/\.(insert|update|upsert|delete)\(/)
      for (const [, name] of file.text.matchAll(/\.rpc\(\s*['"`]([a-z_]+)['"`]/g)) {
        expect(name, file.rel).toMatch(/^admin_/)
      }
    }
  })

  it('imports the service client only in queries/session.ts', () => {
    for (const file of ALL) {
      if (file.rel.endsWith('features/admin/queries/session.ts')) continue
      expect(file.text, file.rel).not.toMatch(/@\/lib\/supabase\/(service|admin)['"]/)
    }
  })
})
