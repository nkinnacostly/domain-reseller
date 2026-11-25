import type { z } from 'zod'
import { type Fetch, globalFetch, timeoutSignal } from '../ses/platform'

/**
 * DeepSeek's chat API, asked for JSON — the one way the product talks to a
 * language model (docs: "Making AI the core of MyDomainsHub"). Server-only:
 * the key never reaches a browser, and nothing here is re-exported from the
 * package root.
 *
 * AI proposes, the engine decides: an answer is data, parsed with the
 * caller's Zod schema, and anything that does not parse is no answer at all.
 * DeepSeek's own API keeps what it is sent in China (privacy policy, Feb
 * 2026), so callers send it no personal data — `redactContactDetails` first.
 *
 * Errors carry a reason and an HTTP status only, never the prompt, the
 * answer or DeepSeek's message, which can quote either (N13).
 */

export type DeepSeekModel = 'deepseek-flash' | 'deepseek-v4-pro'

export type AiSettings = {
  apiKey: string
  /** Customer-facing calls use the cheap fast model; overnight jobs may use the larger one. */
  model?: DeepSeekModel
  baseUrl?: string
  fetch?: Fetch
  timeoutMs?: number
}

export type AiRequest = {
  system: string
  /** The person's own text, already redacted; passed as content, never as instructions. */
  user: string
  /** Enough for the JSON asked for: a cut-off answer is no answer. */
  maxTokens: number
  temperature?: number
}

export type AiFailure =
  | 'timeout'
  | 'unavailable'
  | 'rate_limited'
  | 'credentials'
  | 'balance'
  | 'refused'
  | 'invalid_answer'

export type AiUsage = { promptTokens: number; cachedTokens: number; completionTokens: number }

export type AiAnswer<T> =
  | { ok: true; value: T; usage: AiUsage }
  | { ok: false; reason: AiFailure; status?: number }

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/** A person is waiting: past this, the deterministic results stand alone. */
export const AI_TIMEOUT_MS = 12_000

const FAILURE_BY_STATUS: Readonly<Record<number, AiFailure>> = {
  400: 'refused',
  401: 'credentials',
  402: 'balance',
  422: 'refused',
  429: 'rate_limited',
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

export async function askForJson<T>(
  settings: AiSettings,
  request: AiRequest,
  schema: z.ZodType<T>,
): Promise<AiAnswer<T>> {
  const {
    apiKey,
    model = 'deepseek-flash',
    baseUrl = DEEPSEEK_BASE_URL,
    fetch = globalFetch,
    timeoutMs = AI_TIMEOUT_MS,
  } = settings

  let status: number
  let text: string
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        // JSON mode needs the word "json" in the prompt (the callers' system prompts carry it).
        response_format: { type: 'json_object' },
        // Thinking is on by default; a person is waiting and the task needs none.
        thinking: { type: 'disabled' },
        max_tokens: request.maxTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        stream: false,
      }),
      signal: timeoutSignal(timeoutMs),
    })
    status = response.status
    text = await response.text()
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    return {
      ok: false,
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable',
    }
  }

  if (status !== 200) {
    return { ok: false, reason: FAILURE_BY_STATUS[status] ?? 'unavailable', status }
  }

  // While it works, DeepSeek sends blank lines ahead of the body; JSON.parse skips them.
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'invalid_answer', status }
  }
  const choice = (
    body as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] }
  ).choices?.[0]
  const content = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : ''
  // JSON mode blanks an answer it cannot shape as JSON; a cut-off one is half a list.
  if (!content || choice?.finish_reason !== 'stop') {
    return { ok: false, reason: 'invalid_answer', status }
  }
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return { ok: false, reason: 'invalid_answer', status }
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'invalid_answer', status }

  const usage = (body as { usage?: Record<string, unknown> }).usage ?? {}
  return {
    ok: true,
    value: parsed.data,
    usage: {
      promptTokens: count(usage.prompt_tokens),
      cachedTokens: count(usage.prompt_cache_hit_tokens),
      completionTokens: count(usage.completion_tokens),
    },
  }
}
