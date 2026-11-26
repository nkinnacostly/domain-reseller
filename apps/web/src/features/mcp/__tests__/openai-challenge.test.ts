import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '@/lib/env'

vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }))
const { GET } = await import('@/app/.well-known/openai-apps-challenge/route')

const settings = env as { OPENAI_APPS_CHALLENGE?: string }
const before = settings.OPENAI_APPS_CHALLENGE
afterEach(() => {
  settings.OPENAI_APPS_CHALLENGE = before
})

describe('/.well-known/openai-apps-challenge (AI phase 5)', () => {
  it('is a 404 until a token is set', async () => {
    settings.OPENAI_APPS_CHALLENGE = undefined
    expect((await GET()).status).toBe(404)
  })

  it('serves the token exactly, as plain text, uncached', async () => {
    settings.OPENAI_APPS_CHALLENGE = 'oai-challenge-abc123'
    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('oai-challenge-abc123')
  })
})
