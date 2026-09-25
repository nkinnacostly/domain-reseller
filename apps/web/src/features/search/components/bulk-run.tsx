'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
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
 *
 * Without a search pass (SEC-9) the server checks nothing: the run pauses on
 * that block, the form shows the Turnstile check, and passing it carries on
 * from the same block — before the first, or when a pass runs out mid-list.
 * Refused again straight after a pass, the rest are left not checked, with
 * the reason: asking again would only loop.
 */
type BulkRunApi = {
  run: BulkRun | null
  start: (plan: BulkPlan) => void
  /** Checks again only the names that could not be checked. */
  retry: () => void
  /** Stops after the block in flight; the rest are left not checked. */
  stop: () => void
  /** Paused until the person passes the Turnstile check. */
  awaitingPass: boolean
  /** The check is passed: carry on from the block that was refused. */
  resume: () => void
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
  const paused = useRef<{ id: number; chunks: BulkChunk[] } | null>(null)
  const [awaitingPass, setAwaitingPass] = useState(false)

  const drive = useCallback(async (id: number, chunks: BulkChunk[], afterPass = false) => {
    stopping.current = false
    let isFreshPass = afterPass
    for (const [index, chunk] of chunks.entries()) {
      if (stopping.current || current.current !== id) {
        dispatch({ type: 'halt', id, chunks: chunks.slice(index), reason: 'stopped' })
        break
      }
      const answer = await ask(chunk)
      if (!answer.ok && answer.reason === 'unconfirmed' && !isFreshPass) {
        // Still running, nothing recorded: resume() picks up from this block.
        paused.current = { id, chunks: chunks.slice(index) }
        setAwaitingPass(true)
        return
      }
      isFreshPass = false
      dispatch({ type: 'answer', id, chunk, answer })
      // Every later block would be refused the same way. A refusal straight
      // after a pass means the pass did not arrive: stop, or it would loop.
      if (!answer.ok && (answer.reason === 'limited' || answer.reason === 'unconfirmed')) {
        dispatch({ type: 'halt', id, chunks: chunks.slice(index + 1), reason: answer.reason })
        break
      }
    }
    dispatch({ type: 'finish', id })
  }, [])

  const start = useCallback(
    (plan: BulkPlan) => {
      current.current += 1
      const id = current.current
      paused.current = null
      setAwaitingPass(false)
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

  const resume = useCallback(() => {
    const waiting = paused.current
    paused.current = null
    setAwaitingPass(false)
    if (waiting && current.current === waiting.id) void drive(waiting.id, waiting.chunks, true)
  }, [drive])

  const stop = useCallback(() => {
    stopping.current = true
    // Nothing is in flight while paused, so stop here rather than after it.
    const waiting = paused.current
    if (!waiting) return
    paused.current = null
    setAwaitingPass(false)
    dispatch({ type: 'halt', id: waiting.id, chunks: waiting.chunks, reason: 'stopped' })
    dispatch({ type: 'finish', id: waiting.id })
  }, [])

  const api = useMemo(
    () => ({ run, start, retry, stop, awaitingPass, resume }),
    [run, start, retry, stop, awaitingPass, resume],
  )
  return <BulkRunContext.Provider value={api}>{children}</BulkRunContext.Provider>
}

export function useBulkRun(): BulkRunApi {
  const api = useContext(BulkRunContext)
  if (!api) throw new Error('useBulkRun needs a BulkRunProvider above it')
  return api
}
