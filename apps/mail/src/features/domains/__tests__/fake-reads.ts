import { vi } from 'vitest'

/**
 * A session client double for the domains page's reads (RLS reads of
 * `domains`, `sandbox_identity` and `accounts`): each table answers through
 * a chain, every call is kept, and a read can fail as PostgREST does.
 */

type Answer = { data: unknown; error: unknown }

export function fakeReads(tables: Record<string, Answer>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  function from(table: string) {
    const answer = tables[table] ?? { data: null, error: null }
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'neq', 'order']) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ table, method, args })
        return chain
      }
    }
    chain.maybeSingle = async () => ({
      data: Array.isArray(answer.data) ? (answer.data[0] ?? null) : answer.data,
      error: answer.error,
    })
    // biome-ignore lint/suspicious/noThenProperty: a PostgREST builder is awaited
    chain.then = (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(answer).then(resolve, reject)
    return chain
  }
  return { client: { from: vi.fn(from) }, calls }
}

export function domainRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f',
    name: 'acme.example',
    kind: 'customer',
    status: 'pending',
    dkim_tokens: [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3',
    ],
    dkim_status: 'PENDING',
    mail_from_domain: 'send.acme.example',
    mail_from_status: null,
    failed_reason: null,
    missing_record: null,
    claimed_at: '2026-10-06T09:30:00+00:00',
    created_at: '2026-10-06T09:30:00+00:00',
    verified_at: null,
    last_checked_at: null,
    identity_created_at: '2026-10-06T09:30:01+00:00',
    mail_from_set_at: '2026-10-06T09:30:01+00:00',
    config_set_at: '2026-10-06T09:30:01+00:00',
    tenant_associated_at: '2026-10-06T09:30:02+00:00',
    released_at: null,
    ...overrides,
  }
}
