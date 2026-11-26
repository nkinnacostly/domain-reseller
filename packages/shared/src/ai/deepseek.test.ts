import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { recordingFetch } from '../ses/test-fetch'
import { askForJson } from './deepseek'

/** An answer as DeepSeek's chat API sends it: the model's JSON as a string inside `choices`. */
const answer = (content: unknown, finish = 'stop', usage: unknown = {}) => ({
  status: 200,
  body: {
    choices: [
      {
        message: { content: typeof content === 'string' ? content : JSON.stringify(content) },
        finish_reason: finish,
      },
    ],
    usage,
  },
})

const schema = z.object({ names: z.array(z.string()) })
const request = { system: 'Reply in json.', user: 'A bakery in Ibadan', maxTokens: 400 }
const settings = (fetch: ReturnType<typeof recordingFetch>['fetch']) => ({
  apiKey: 'sk-test',
  fetch,
})

describe('askForJson — failures first', () => {
  it('sorts refusals by cause, never by message text', async () => {
    const cases: [number, string][] = [
      [400, 'refused'],
      [401, 'credentials'],
      [402, 'balance'],
      [422, 'refused'],
      [429, 'rate_limited'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ]
    for (const [status, reason] of cases) {
      const { fetch } = recordingFetch({
        status,
        body: { error: { message: 'quotes "A bakery"' } },
      })
      expect(await askForJson(settings(fetch), request, schema)).toEqual({
        ok: false,
        reason,
        status,
      })
    }
  })

  it('reads a timeout as a timeout and any other failure to answer as unavailable', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    expect(await askForJson(settings(recordingFetch(timeout).fetch), request, schema)).toEqual({
      ok: false,
      reason: 'timeout',
    })
    expect(
      await askForJson(settings(recordingFetch(new Error('ECONNRESET')).fetch), request, schema),
    ).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('takes no answer from a body that is not JSON, a blank or cut-off reply, or one off the schema', async () => {
    for (const scripted of [
      { status: 200, body: 'not json' },
      answer('   '),
      answer({ names: ['getpaid'] }, 'length'),
      answer('{"names": ["unfinished"'),
      answer({ names: 'getpaid' }),
      { status: 200, body: { choices: [] } },
    ]) {
      const { fetch } = recordingFetch(scripted)
      expect(await askForJson(settings(fetch), request, schema)).toMatchObject({
        ok: false,
        reason: 'invalid_answer',
        status: 200,
      })
    }
  })

  it('keeps what an unusable answer was billed, cached tokens never above those sent', async () => {
    const { fetch } = recordingFetch(
      answer({ names: ['half'] }, 'length', {
        prompt_tokens: 500,
        prompt_cache_hit_tokens: 900,
        completion_tokens: 1200.7,
      }),
    )
    expect(await askForJson(settings(fetch), request, schema)).toEqual({
      ok: false,
      reason: 'invalid_answer',
      status: 200,
      usage: { promptTokens: 500, cachedTokens: 500, completionTokens: 1200 },
    })
    const { fetch: bare } = recordingFetch({ status: 200, body: 'not json' })
    expect(await askForJson(settings(bare), request, schema)).not.toHaveProperty('usage')
  })
})

describe('askForJson', () => {
  it('asks the fast model for JSON with thinking off, and returns the parsed answer and usage', async () => {
    const { fetch, calls } = recordingFetch(
      answer({ names: ['getpaid', 'payhub'] }, 'stop', {
        prompt_tokens: 600,
        prompt_cache_hit_tokens: 512,
        completion_tokens: 40,
      }),
    )
    const result = await askForJson(settings(fetch), { ...request, temperature: 1.1 }, schema)

    expect(result).toEqual({
      ok: true,
      value: { names: ['getpaid', 'payhub'] },
      usage: { promptTokens: 600, cachedTokens: 512, completionTokens: 40 },
    })
    expect(calls[0]?.url).toBe('https://api.deepseek.com/chat/completions')
    expect(calls[0]?.init.headers.authorization).toBe('Bearer sk-test')
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: 'Reply in json.' },
        { role: 'user', content: 'A bakery in Ibadan' },
      ],
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      max_tokens: 400,
      temperature: 1.1,
      stream: false,
    })
  })

  it('takes the larger model and another base address when asked, and reads missing usage as zero', async () => {
    const { fetch, calls } = recordingFetch({
      status: 200,
      body: `\n\n${JSON.stringify(answer({ names: [] }).body)}`,
    })
    const result = await askForJson(
      { apiKey: 'k', fetch, model: 'deepseek-v4-pro', baseUrl: 'http://ai.test' },
      request,
      schema,
    )
    expect(result).toEqual({
      ok: true,
      value: { names: [] },
      usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
    })
    expect(calls[0]?.url).toBe('http://ai.test/chat/completions')
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toMatchObject({ model: 'deepseek-v4-pro' })
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).not.toHaveProperty('temperature')
  })
})
