import type { Database } from '@dr/db'
import {
  type AiAnswer,
  type AiRequest,
  askForJson,
  cleanNameIdeas,
  type DeepSeekModel,
  NAME_IDEA_WORDS,
  type NameIdea,
  type NameIdeasAnswer,
  nameIdeasAnswer,
  nameIdeasRequest,
} from '@dr/shared/ai'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { countingAsk } from '../lib/ai-usage'

/**
 * Pre-built name ideas for the curated words (docs: "Making AI the core of
 * MyDomainsHub", feature 2; ADR-002 v1.1). Each hour, outside DeepSeek's
 * peak, the job asks for ideas around up to WORDS_PER_RUN words that have
 * none or whose ideas are over REFRESH_DAYS old, and keeps them in
 * `name_idea_words`; a search for exactly a word adds them to its
 * suggestions, so no model sits in the request path.
 *
 * The words are ours (NAME_IDEA_WORDS): nothing from a person is sent, and
 * no search is recorded (FR-S7). Never calls the supplier: the ideas are
 * checked for availability when someone searches.
 */

/** Every word refreshed monthly: names get taken, and better ideas come. */
export const REFRESH_DAYS = 30
/** About 285 words, so a new list is built within a night; ~$0.002 a word. */
export const WORDS_PER_RUN = 40
const MODEL: DeepSeekModel = 'deepseek-v4-pro'

/**
 * DeepSeek doubles its prices 01:00–04:00 and 06:00–10:00 UTC on weekdays
 * (pricing page, Nov 2026); the job waits those hours out.
 */
export function isOffPeak(at: Date): boolean {
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return true
  const hour = at.getUTCHours()
  return !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
}

/** Words with no ideas first, in list order; then the oldest past REFRESH_DAYS. */
export function dueWords(
  words: readonly string[],
  generatedAt: ReadonlyMap<string, string>,
  now: Date,
  limit: number,
): string[] {
  const cutoff = now.getTime() - REFRESH_DAYS * 86_400_000
  const missing = words.filter((word) => !generatedAt.has(word))
  const stale = words
    .filter((word) => {
      const at = generatedAt.get(word)
      return at !== undefined && Date.parse(at) < cutoff
    })
    .sort((a, b) => Date.parse(generatedAt.get(a) ?? '') - Date.parse(generatedAt.get(b) ?? ''))
  return [...missing, ...stale].slice(0, limit)
}

export type IdeasStore = {
  /** When each word's ideas were built. */
  generatedAt(): Promise<Map<string, string>>
  save(word: string, ideas: NameIdea[], model: string): Promise<void>
}

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type IdeasRun = { built: number; empty: number; failed: number; skipped?: 'peak' }

export function createIdeasJob(options: {
  store: IdeasStore
  ask: (request: AiRequest) => Promise<AiAnswer<NameIdeasAnswer>>
  words?: readonly string[]
  perRun?: number
  everyMs: number
  now?: () => Date
  log: Log
}) {
  const {
    store,
    ask,
    words = NAME_IDEA_WORDS,
    perRun = WORDS_PER_RUN,
    everyMs,
    now = () => new Date(),
    log,
  } = options

  async function runOnce(): Promise<IdeasRun> {
    const run: IdeasRun = { built: 0, empty: 0, failed: 0 }
    if (!isOffPeak(now())) return { ...run, skipped: 'peak' }
    for (const word of dueWords(words, await store.generatedAt(), now(), perRun)) {
      const answer = await ask(nameIdeasRequest({ kind: 'word', text: word }))
      if (!answer.ok) {
        run.failed += 1
        log.warn({ word, reason: answer.reason, status: answer.status }, 'name ideas: no answer')
        // A key or a balance problem fails every word alike: stop and wait for a person.
        if (answer.reason === 'credentials' || answer.reason === 'balance') break
        continue
      }
      const ideas = cleanNameIdeas(answer.value)
      if (ideas.length === 0) {
        run.empty += 1
        continue
      }
      await store.save(word, ideas, MODEL)
      run.built += 1
    }
    if (run.built + run.empty + run.failed > 0) log.info(run, 'name ideas built')
    return run
  }

  let timer: NodeJS.Timeout | null = null
  let current: Promise<void> | null = null
  let running = false

  async function cycle() {
    try {
      await runOnce()
    } catch (error) {
      log.error({ err: error }, 'name ideas failed')
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

export function createIdeasStore(client: SupabaseClient<Database>): IdeasStore {
  return {
    async generatedAt() {
      const { data, error } = await client.from('name_idea_words').select('word, generated_at')
      if (error) throw new Error(error.message)
      return new Map((data ?? []).map((row) => [row.word, row.generated_at]))
    },
    async save(word, ideas, model) {
      const { error } = await client
        .from('name_idea_words')
        .upsert({ word, ideas, model, generated_at: new Date().toISOString() })
      if (error) throw new Error(error.message)
    },
  }
}

/**
 * The live gateway's job, or null: only the production deployment that
 * writes to the live registry builds ideas (one job for the shared table),
 * and only once DEEPSEEK_API_KEY is set.
 */
export function ideasJobFor(
  env: Env,
  log: Log,
  /** Test seam: the database. */
  deps: { client?: SupabaseClient<Database> } = {},
) {
  if (env.DNA_WRITE_ENV !== 'production' || !env.DEEPSEEK_API_KEY) return null
  const apiKey = env.DEEPSEEK_API_KEY
  const client =
    deps.client ??
    createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  return createIdeasJob({
    store: createIdeasStore(client),
    ask: countingAsk(
      (request) => askForJson({ apiKey, model: MODEL }, request, nameIdeasAnswer),
      'name_ideas_overnight',
      MODEL,
      client,
      log,
    ),
    everyMs: 3_600_000,
    log,
  })
}
