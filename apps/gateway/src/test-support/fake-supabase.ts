import { vi } from 'vitest'

/**
 * A Supabase client that answers `rpc` from a table of results, for testing
 * the thin store wrappers: which function they call, with what, and what
 * they make of the answer. The database functions themselves are tested
 * against the real project (`*.db.test.ts`, `money_invariants.sql`).
 */
export function fakeRpcClient(
  answers: Record<string, { data?: unknown; error?: { message: string } | null }> = {},
) {
  const rpc = vi.fn(async (name: string, _args?: unknown) => ({
    data: answers[name]?.data ?? null,
    error: answers[name]?.error ?? null,
  }))
  return { client: { rpc } as never, rpc }
}
