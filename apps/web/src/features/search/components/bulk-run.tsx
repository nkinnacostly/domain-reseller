'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react'
import { checkBulkNames } from '../actions/bulk'
import type { BulkChunk, BulkPlan } from '../lib/bulk'
import { type BulkAnswer, type BulkRun, reduceRun, retryChunks } from '../lib/bulk-run'

/**
 * Runs a bulk search (FR-S5) and shares it between the form on the hero and
 * the results below it.
 *
 * Blocks go to the server one at a time: the supplier allows two calls in
 * flight for everyone (PRD V4), so a list is checked in turn rather than all
 * at once, and each answer is shown as it lands. A block that fails leaves
 * its names "not checked", to be retried on their own; a connection that has
 * checked too much is stopped there, since every later block would be too.
 */
type BulkRunApi = {
  run: BulkRun | null
  start: (plan: BulkPlan) => void
  /** Checks again only the names that could not be checked. */
  retry: () => void
  /** Stops after the block in flight; the rest are left not checked. */
  stop: () => void
}

const BulkRunContext = createContext<BulkRunApi | null>(null)

async function ask(chunk: BulkChunk): Promise<BulkAnswer> {
  try {
    const result = await checkBulkNames(chunk)
    return result?.data ?? { ok: false, reason: 'unavailable' }
  } catch {
    // The request itself failed — offline, or the server went away.
    return { ok: false, reason: 'unavailable' }
  }
}

export function BulkRunProvider({ children }: { children: React.ReactNode }) {
  const [run, dispatch] = useReducer(reduceRun, null)
  const latest = useRef<BulkRun | null>(null)
  useEffect(() => {
    latest.current = run
  }, [run])
  const current = useRef(0)
  const stopping = useRef(false)

  const drive = useCallback(async (id: number, chunks: BulkChunk[]) => {
    stopping.current = false
    for (const [index, chunk] of chunks.entries()) {
      if (stopping.current || current.current !== id) {
        dispatch({ type: 'halt', id, chunks: chunks.slice(index), reason: 'stopped' })
        break
      }
      const answer = await ask(chunk)
      dispatch({ type: 'answer', id, chunk, answer })
      if (!answer.ok && answer.reason === 'limited') {
        dispatch({ type: 'halt', id, chunks: chunks.slice(index + 1), reason: 'limited' })
        break
      }
    }
    dispatch({ type: 'finish', id })
  }, [])

  const start = useCallback(
    (plan: BulkPlan) => {
      current.current += 1
      const id = current.current
      dispatch({ type: 'start', id, plan })
      void drive(id, plan.chunks)
    },
    [drive],
  )

  const retry = useCallback(() => {
    const now = latest.current
    if (!now || now.running) return
    const chunks = retryChunks(now)
    if (chunks.length === 0) return
    dispatch({ type: 'retry', id: now.id })
    void drive(now.id, chunks)
  }, [drive])

  const stop = useCallback(() => {
    stopping.current = true
  }, [])

  const api = useMemo(() => ({ run, start, retry, stop }), [run, start, retry, stop])
  return <BulkRunContext.Provider value={api}>{children}</BulkRunContext.Provider>
}

export function useBulkRun(): BulkRunApi {
  const api = useContext(BulkRunContext)
  if (!api) throw new Error('useBulkRun needs a BulkRunProvider above it')
  return api
}
