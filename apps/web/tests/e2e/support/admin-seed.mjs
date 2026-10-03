/**
 * Seeds for the admin e2e suites (ADMIN-SPEC §3.2j, §8.1), through the
 * test-only SQL helpers, with the secret key. Each refuses anything but test
 * rows of e2e-*@example.com users, so a seed can never touch a customer's
 * record or real money (N12). Teardown purges the ledger rows seeded here.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

function service() {
  const path = fileURLToPath(new URL('../../../../../.env', import.meta.url))
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key && !process.env[key]) process.env[key] = rest.join('=').replace(/^["']|["']$/g, '')
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/** Moves a queued test refund to held, as if it were over a limit. */
export async function holdTestRefund(refundId) {
  const { error } = await service().rpc('hold_test_refund', { p_refund_id: refundId })
  if (error) throw error
}

/** Queues one failed test email for the user, for "Send again". Returns its id. */
export async function seedTestFailedEmail(userId) {
  const { data, error } = await service().rpc('seed_test_failed_email', { p_user_id: userId })
  if (error) throw error
  return data
}

/**
 * Records test-side supplier ledger rows as the sync would. Descriptions are
 * prefixed `e2e-` so teardown's purge finds them; times carry their zone.
 *
 * @param {{ description: string, deltaCents: number, balanceBeforeCents?: number, occurredAt?: string, type?: number }[]} rows
 */
export async function seedTestLedgerEntries(rows) {
  const payload = rows.map((row) => {
    const before = row.balanceBeforeCents ?? 100_000
    return {
      traceId: randomUUID(),
      occurredAt: row.occurredAt ?? new Date().toISOString(),
      type: row.type ?? (row.deltaCents < 0 ? 2 : 1),
      status: 1,
      chargeType: 0,
      productType: 0,
      productId: null,
      description: row.description.startsWith('e2e-') ? row.description : `e2e-${row.description}`,
      period: null,
      oldBalanceCents: before,
      balanceCents: before + row.deltaCents,
    }
  })
  const { data, error } = await service().rpc('record_supplier_ledger', {
    p_test_mode: true,
    p_rows: payload,
  })
  if (error) throw error
  return { result: data, traceIds: payload.map((row) => row.traceId) }
}
