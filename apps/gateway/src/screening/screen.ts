import type { Database } from '@dr/db'
import {
  type AiAnswer,
  type AiRequest,
  askForJson,
  cleanScreeningReason,
  type DeepSeekModel,
  type ScreeningAnswer,
  screeningAnswer,
  screeningMatches,
  screeningRequest,
} from '@dr/shared/ai'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'

/**
 * Order screening (migration 73; docs: "Making AI the core of MyDomainsHub",
 * feature 6). Every ten minutes the live gateway reads paid registration and
 * transfer lines with no screening and records one for each: clear when the
 * name holds no listed brand, which is nearly all of them and asks no one;
 * otherwise the model's opinion, and "review" whenever it cannot be asked.
 * A review raises a warning for a person. Nothing here holds, refuses or
 * changes an order — the screening only informs a person.
 *
 * Only the domain name and the words it matched leave for DeepSeek; logs
 * carry line ids and counts, never a name (N13).
 */

const MODEL: DeepSeekModel = 'deepseek-flash'
export const SCREEN_EVERY_MS = 10 * 60_000
export const LINES_PER_RUN = 50

export type DueLine = { orderItemId: string; domain: string }

export type Screening = {
  orderItemId: string
  testMode: boolean
  domain: string
  verdict: 'clear' | 'review'
  matched: string[]
  note: string | null
  model: string | null
}

export type ScreeningStore = {
  due(testMode: boolean, limit: number): Promise<DueLine[]>
  /** False when the line was screened already (another run got there first). */
  save(screening: Screening): Promise<boolean>
}

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type ScreeningRun = { clear: number; review: number; asked: number; failed: number }

const NOT_ASKED: Record<string, string> = {
  timeout: 'The model did not answer in time',
  unavailable: 'The model was unavailable',
  rate_limited: 'The model was busy',
  credentials: 'The model refused our key',
  balance: 'The DeepSeek balance has run out',
  refused: 'The model refused the request',
  invalid_answer: 'The model gave no usable answer',
}

/** What to record for one line; `ask` is null when no key is set. */
export async function screenLine(
  line: DueLine,
  testMode: boolean,
  ask: ((request: AiRequest) => Promise<AiAnswer<ScreeningAnswer>>) | null,
): Promise<{ screening: Screening; asked: boolean; failed: boolean }> {
  const { brands, lures } = screeningMatches(line.domain)
  const base = { orderItemId: line.orderItemId, testMode, domain: line.domain }
  if (brands.length === 0) {
    return {
      screening: { ...base, verdict: 'clear', matched: [], note: null, model: null },
      asked: false,
      failed: false,
    }
  }
  const matched = [...brands, ...lures]
  if (!ask) {
    const note = 'Contains a listed name; no model is set up, so a person should look.'
    return {
      screening: { ...base, verdict: 'review', matched, note, model: null },
      asked: false,
      failed: false,
    }
  }
  const answer = await ask(screeningRequest(line.domain, matched))
  if (!answer.ok) {
    const note = `${NOT_ASKED[answer.reason] ?? 'The model could not be asked'}, so a person should look.`
    return {
      screening: { ...base, verdict: 'review', matched, note, model: null },
      asked: true,
      failed: true,
    }
  }
  return {
    screening: {
      ...base,
      verdict: answer.value.verdict,
      matched,
      note: cleanScreeningReason(answer.value.reason),
      model: MODEL,
    },
    asked: true,
    failed: false,
  }
}

export function createScreeningJob(options: {
  store: ScreeningStore
  ask: ((request: AiRequest) => Promise<AiAnswer<ScreeningAnswer>>) | null
  testMode: boolean
  everyMs?: number
  perRun?: number
  log: Log
}) {
  const { store, ask, testMode, everyMs = SCREEN_EVERY_MS, perRun = LINES_PER_RUN, log } = options

  async function runOnce(): Promise<ScreeningRun> {
    const run: ScreeningRun = { clear: 0, review: 0, asked: 0, failed: 0 }
    for (const line of await store.due(testMode, perRun)) {
      const { screening, asked, failed } = await screenLine(line, testMode, ask)
      if (asked) run.asked += 1
      if (failed) {
        run.failed += 1
        log.warn({ orderItemId: line.orderItemId }, 'order screening: model not asked')
      }
      if (!(await store.save(screening))) continue
      run[screening.verdict] += 1
    }
    if (run.clear + run.review > 0) log.info(run, 'order lines screened')
    return run
  }

  let timer: NodeJS.Timeout | null = null
  let current: Promise<void> | null = null
  let running = false

  async function cycle() {
    try {
      await runOnce()
    } catch (error) {
      log.error({ err: error }, 'order screening failed')
    }
    if (!running) return
    timer = setTimeout(() => {
      current = cycle()
    }, everyMs)
  }

  return {
    runOnce,
    start() {
      if (running) return
      running = true
      current = cycle()
    },
    async stop() {
      running = false
      if (timer) clearTimeout(timer)
      timer = null
      await current
    },
  }
}

export function createScreeningStore(client: SupabaseClient<Database>): ScreeningStore {
  return {
    async due(testMode, limit) {
      const { data, error } = await client.rpc('order_lines_to_screen', {
        p_test_mode: testMode,
        p_limit: limit,
      })
      if (error) throw new Error(error.message)
      return (data ?? []).map((row) => ({ orderItemId: row.order_item_id, domain: row.domain }))
    },
    async save(screening) {
      const { error } = await client.from('order_screenings').insert({
        order_item_id: screening.orderItemId,
        test_mode: screening.testMode,
        domain: screening.domain,
        verdict: screening.verdict,
        matched: screening.matched,
        note: screening.note,
        model: screening.model,
      })
      if (error?.code === '23505') return false
      if (error) throw new Error(error.message)
      return true
    },
  }
}

/**
 * The live gateway's job, or null: real orders are screened, test ones are
 * not (their names are ours). The word list runs without DeepSeek; with
 * DEEPSEEK_API_KEY set, a listed name gets the model's opinion too.
 */
export function screeningJobFor(
  env: Env,
  log: Log,
  /** Test seam: the database. */
  deps: { client?: SupabaseClient<Database> } = {},
) {
  if (env.DNA_WRITE_ENV !== 'production') return null
  const apiKey = env.DEEPSEEK_API_KEY
  const client =
    deps.client ??
    createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  return createScreeningJob({
    store: createScreeningStore(client),
    ask: apiKey
      ? (request) => askForJson({ apiKey, model: MODEL }, request, screeningAnswer)
      : null,
    testMode: false,
    log,
  })
}
