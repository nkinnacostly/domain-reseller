import { EventEmitter } from 'node:events'
import { request } from 'node:https'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getJson, NoAnswer, requestJson } from './http'

vi.mock('node:https', () => ({ request: vi.fn() }))

type Answer =
  | { status: number; body: string }
  | { error: string }
  | { timeout: true }
  | { dropped: string }

/** A stand-in for node:https that answers each request as told. */
function answer(outcome: Answer) {
  const sent: { url: string; options: Record<string, unknown>; written: string[] }[] = []
  vi.mocked(request).mockImplementation(((
    url: string,
    options: Record<string, unknown>,
    callback: (res: EventEmitter & { statusCode?: number }) => void,
  ) => {
    const written: string[] = []
    sent.push({ url, options, written })
    const req = Object.assign(new EventEmitter(), {
      write: (chunk: string) => written.push(chunk),
      destroy: (error: Error) => req.emit('error', error),
      end: () =>
        queueMicrotask(() => {
          if ('error' in outcome) return void req.emit('error', new Error(outcome.error))
          if ('timeout' in outcome) return void req.emit('timeout')
          const res = Object.assign(new EventEmitter(), {
            statusCode: 'status' in outcome ? outcome.status : 200,
          })
          callback(res)
          if ('dropped' in outcome) return void res.emit('error', new Error(outcome.dropped))
          res.emit('data', Buffer.from(outcome.body))
          res.emit('end')
        }),
    })
    return req
  }) as never)
  return sent
}

beforeEach(() => vi.clearAllMocks())

describe('requestJson', () => {
  it('resolves every HTTP answer with its status — the caller decides what it means', async () => {
    answer({ status: 400, body: '{"status":"error","message":"no"}' })
    expect(await requestJson('https://x.test/a')).toEqual({
      status: 400,
      body: { status: 'error', message: 'no' },
    })
  })

  it('reads an unreadable or empty body as null, not a crash', async () => {
    answer({ status: 502, body: '<html>bad gateway</html>' })
    expect(await requestJson('https://x.test/a')).toEqual({ status: 502, body: null })
    answer({ status: 204, body: '' })
    expect(await requestJson('https://x.test/a')).toEqual({ status: 204, body: null })
  })

  it('sends a JSON body with its length, and the caller’s headers', async () => {
    const sent = answer({ status: 200, body: '{}' })
    await requestJson('https://x.test/refund', {
      method: 'POST',
      body: { amount: 196.72 },
      headers: { Authorization: 'Bearer k' },
    })
    expect(sent[0]?.options).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': 17,
        Authorization: 'Bearer k',
      },
    })
    expect(sent[0]?.written).toEqual(['{"amount":196.72}'])
  })

  it.each([
    ['a connection error', { error: 'ECONNRESET' }],
    ['a timeout', { timeout: true }],
    ['a response cut off mid-way', { dropped: 'aborted' }],
  ] as const)('rejects %s as NoAnswer: nobody knows what happened', async (_, outcome) => {
    answer(outcome)
    await expect(requestJson('https://x.test/a')).rejects.toBeInstanceOf(NoAnswer)
  })
})

describe('getJson', () => {
  it('resolves a JSON answer', async () => {
    answer({ status: 200, body: '{"ok":true}' })
    expect(await getJson('https://x.test/a')).toEqual({ ok: true })
  })

  it('rejects an HTTP error, and a body that is not JSON', async () => {
    answer({ status: 500, body: 'oops' })
    await expect(getJson('https://x.test/a')).rejects.toThrow(/HTTP 500/)
    answer({ status: 200, body: 'not json' })
    await expect(getJson('https://x.test/a')).rejects.toThrow(/Non-JSON/)
  })

  it('rejects when there is no answer', async () => {
    answer({ timeout: true })
    await expect(getJson('https://x.test/a')).rejects.toThrow(/timeout/)
  })
})
