import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADMIN_TABLES, PRIVATE_COLUMNS, selectedColumns } from '@/features/admin/queries/session'

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

/** §8.1's list, and the personal data D4 keeps to the reveal functions. adminDb refuses the same. */
const BANNED_COLUMNS = [...PRIVATE_COLUMNS]

const SESSION = 'features/admin/queries/session.ts'

type Select = { columns: string | null; table: string | null }

/**
 * Every `.select(` call: its first argument when that is a string or a
 * template literal with nothing interpolated (else null, which fails), and
 * the table of the nearest `.from('…')` before it in the file.
 */
function selects(text: string): Select[] {
  const found: Select[] = []
  for (const match of text.matchAll(/\.select\(\s*/g)) {
    const at = (match.index ?? 0) + match[0].length
    const literal = /^(['"`])([\s\S]*?)\1/.exec(text.slice(at))
    const columns =
      literal && !(literal[1] === '`' && (literal[2] ?? '').includes('${'))
        ? (literal[2] ?? '')
        : null
    const before = [...text.slice(0, match.index).matchAll(/\.from\(\s*['"`]([a-z_]+)['"`]/g)].at(
      -1,
    )
    found.push({ columns, table: before?.[1] ?? null })
  }
  return found
}

/** The table whose embed a select on `table` may carry: its side parent, if any. */
function parentOf(table: string | null): string | null {
  const entry = table
    ? (ADMIN_TABLES as Record<string, { side: { kind: string; parent?: string } }>)[table]
    : undefined
  return entry?.side.kind === 'parent' ? (entry.side.parent ?? null) : null
}

/**
 * §9: the sensitive projections each B package may use; everything else is
 * banned. Areas are the B packages' paths: `app/(admin)/admin/<area>/**`,
 * `components/<area>/**`, `queries|actions|schemas/<area>.ts`,
 * `lib/<area>-*.ts`. Any other admin file is Package A's (`foundation`).
 * admin_orders_v is not here: it replaces `orders` and holds nothing personal.
 */
const PERMITTED: Readonly<Record<string, readonly string[]>> = {
  foundation: ['admin_attention_counts', 'checkFlutterwaveRefund'],
  overview: ['admin_overview', 'admin_attention_counts', 'admin_float'],
  orders: ['admin_payments_v', 'order_item_costs', 'admin_customers', 'admin_domains_v'],
  refunds: ['admin_refund_stats', 'checkFlutterwaveRefund'],
  queue: ['admin_domains_v'],
  alerts: ['admin_overview'],
  supplier: [
    'admin_float',
    'admin_ledger_daily',
    'supplier_ledger_entries',
    'supplier_ledger_revisions',
    'float_topups',
  ],
  money: ['admin_revenue', 'admin_margin'],
  customers: [
    'admin_customers',
    'admin_customer',
    'admin_customer_stats',
    'admin_find_customers',
    'admin_reveal_customer',
  ],
  domains: ['admin_domains_v', 'registrant_country', 'registrant_type', 'admin_reveal_registrant'],
  ssl: ['admin_ssl_certificates_v', 'approver_masked', 'certificate_pem', 'ca_bundle_pem'],
  emails: [
    'admin_email_outbox_v',
    'admin_compliance_notices_v',
    'masked_to',
    'last_error_safe',
    'masked_recipient',
  ],
  pricing: ['admin_pricing_status'],
  settings: [
    'admin_tld_held_counts',
    'admin_preset_usage',
    'admin_list_admins',
    'nameserver_preset_drafts',
  ],
  audit: ['admin_audit_log'],
}

const SENSITIVE = [
  ...new Set([
    ...Object.values(PERMITTED).flat(),
    'admin_reveal_customer',
    'admin_reveal_registrant',
  ]),
]

/** B13 and B3/B4 own action files named for what they do, not their area. */
const ACTION_AREA: Readonly<Record<string, string>> = {
  incidents: 'refunds',
  jobs: 'queue',
  extensions: 'settings',
  'ssl-products': 'settings',
  presets: 'settings',
}

function areaOf(rel: string): string {
  if (rel === 'app/(admin)/admin/page.tsx') return 'overview'
  const named =
    /^app\/\(admin\)\/admin\/([a-z-]+)\//.exec(rel)?.[1] ??
    /^features\/admin\/components\/([a-z-]+)\//.exec(rel)?.[1] ??
    /^features\/admin\/lib\/([a-z]+)-[a-z-]+\.ts$/.exec(rel)?.[1] ??
    /^features\/admin\/(?:queries|actions|schemas)\/([a-z-]+)\.ts$/.exec(rel)?.[1]
  const area = named ? (ACTION_AREA[named] ?? named) : null
  return area && area !== 'foundation' && area in PERMITTED ? area : 'foundation'
}

const mentions = (text: string, name: string) =>
  new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(text)

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

  it('selects only from a string the scan can read: no variable, no interpolation', () => {
    for (const file of ALL) {
      // session.ts's own select(list, options) is adminDb's, after its checks.
      if (file.rel === SESSION) continue
      for (const { columns } of selects(file.text)) {
        expect(columns, `${file.rel} selects from something other than a literal`).not.toBeNull()
      }
    }
  })

  it("never selects '*'", () => {
    for (const file of ALL) {
      for (const { columns } of selects(file.text)) {
        if (columns === null) continue
        expect(columns.trim(), file.rel).not.toBe('*')
        expect(columns, file.rel).not.toMatch(/(^|[\s,(])\*(\s*[,)]|\s*$)/)
      }
    }
  })

  it('embeds nothing but the side parent, by plain names: no alias, cast or JSON path', () => {
    for (const file of ALL) {
      if (file.rel === SESSION) continue
      for (const { columns, table } of selects(file.text)) {
        if (columns === null) continue
        expect(
          selectedColumns(columns, parentOf(table)),
          `${file.rel} selects ${JSON.stringify(columns)} from ${table ?? 'an unknown table'}`,
        ).not.toBeNull()
      }
    }
  })

  it('selects no column that holds personal data, a secret or a raw provider answer', () => {
    for (const file of ALL) {
      for (const { columns } of selects(file.text)) {
        if (columns === null) continue
        for (const banned of BANNED_COLUMNS) {
          if (banned === 'key' && file.rel.endsWith('queries/alerts.ts')) continue
          // Whole names only: idempotency_key and checked_data pass.
          const whole = new RegExp(`(^|[^a-z0-9_])${banned}([^a-z0-9_]|$)`)
          expect(whole.test(columns), `${file.rel} selects ${banned}`).toBe(false)
        }
      }
    }
  })

  it('uses a sensitive projection only in the package §9 gives it to', () => {
    for (const file of ALL) {
      if (file.rel === SESSION) continue
      const area = areaOf(file.rel)
      const permitted = PERMITTED[area] ?? []
      for (const name of SENSITIVE) {
        if (!mentions(file.text, name)) continue
        expect(permitted, `${file.rel} (${area}) uses ${name}`).toContain(name)
      }
    }
  })

  it('places every B package path in its area, and the rest in Package A', () => {
    expect(areaOf('app/(admin)/admin/page.tsx')).toBe('overview')
    expect(areaOf('app/(admin)/admin/customers/[id]/page.tsx')).toBe('customers')
    expect(areaOf('features/admin/components/domains/registrant.tsx')).toBe('domains')
    expect(areaOf('features/admin/queries/supplier.ts')).toBe('supplier')
    expect(areaOf('features/admin/actions/incidents.ts')).toBe('refunds')
    expect(areaOf('features/admin/actions/presets.ts')).toBe('settings')
    expect(areaOf('features/admin/lib/refunds-copy.ts')).toBe('refunds')
    expect(areaOf('features/admin/schemas/settings.ts')).toBe('settings')
    expect(areaOf('features/admin/queries/attention.ts')).toBe('foundation')
    expect(areaOf('features/admin/lib/list-params.ts')).toBe('foundation')
    expect(areaOf('features/admin/components/shell/nav.ts')).toBe('foundation')
    expect(areaOf('app/(admin)/admin/layout.tsx')).toBe('foundation')
    // A reveal in the wrong package is caught.
    expect(PERMITTED.orders).not.toContain('admin_reveal_registrant')
    expect(PERMITTED.queue).not.toContain('admin_reveal_customer')
    expect(mentions("rpc('admin_reveal_registrant', {})", 'admin_reveal_registrant')).toBe(true)
    expect(mentions('admin_reveal_registrants', 'admin_reveal_registrant')).toBe(false)
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
        'admin_orders_v',
        'nameserver_preset_drafts',
        'nameserver_presets',
        'ops_alerts',
        'ops_settings',
        'order_item_costs',
        'order_items',
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

  it('runs every admin e2e spec without screenshots, video or traces', () => {
    const e2e = join(SRC, '../tests/e2e')
    const specs = readdirSync(e2e).filter((name) => /^admin.*\.spec\.ts$/.test(name))
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) {
      const text = readFileSync(join(e2e, spec), 'utf8')
      expect(text, spec).toMatch(/import \{[^}]*\btest\b[^}]*\} from '\.\/support\/admin'/)
      expect(text, spec).not.toMatch(/import \{[^}]*\btest\b[^}]*\} from '@playwright\/test'/)
    }
  })
})
