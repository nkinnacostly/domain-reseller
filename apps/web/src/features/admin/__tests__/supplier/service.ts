import { vi } from 'vitest'
import { createServiceClient } from '@/lib/supabase/service'

export type Call = [string, ...unknown[]]

type Answer = { data?: unknown; error?: unknown; count?: number | null }

const METHODS = ['select', 'eq', 'in', 'gte', 'lt', 'not', 'order', 'range', 'limit']

/**
 * A service client whose reads record every call and answer by table, for
 * reads through adminDb (which needs `createServiceClient` mocked first).
 * A table without an answer gets an empty list.
 */
export function fakeService(answers: Record<string, Answer> = {}) {
  const calls: Call[] = []
  vi.mocked(createServiceClient).mockReturnValue({
    from: (name: string) => {
      calls.push(['from', name])
      const builder: Record<string, unknown> = {}
      for (const method of METHODS) {
        builder[method] = (...args: unknown[]) => {
          calls.push([method, ...args])
          return builder
        }
      }
      const answer = answers[name] ?? { data: [] }
      // biome-ignore lint/suspicious/noThenProperty: PostgREST's builder is awaited, so the fake is a thenable too
      builder.then = (resolve: (value: unknown) => unknown) =>
        resolve({
          data: answer.data ?? null,
          error: answer.error ?? null,
          count: answer.count ?? null,
        })
      return builder
    },
  } as never)
  return calls
}
