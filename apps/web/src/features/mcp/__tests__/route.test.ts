import { describe, expect, it, vi } from 'vitest'

vi.mock('@/features/mcp/queries/tools', () => ({
  MCP_TOOLS: [],
  MCP_TOOLS_READ_ONLY: [],
}))
const { POST, GET } = await import('@/app/mcp/route')
const chatgpt = await import('@/app/mcp/chatgpt/route')

const post = (body: string, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://localhost/mcp', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  )

describe('/mcp', () => {
  it('answers a request as JSON, uncached', async () => {
    const response = await post(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  it('accepts a notification with 202 and no body', async () => {
    const response = await post(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    )
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  it('refuses broken JSON, an oversized body, and GET', async () => {
    expect((await post('{nope')).status).toBe(400)
    expect((await post('{}', { 'content-length': String(100_000) })).status).toBe(413)
    const get = GET()
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
  })
})

describe('/mcp/chatgpt (AI phase 5)', () => {
  it('answers like /mcp, with instructions that promise no cart link', async () => {
    const response = await chatgpt.POST(
      new Request('http://localhost/mcp/chatgpt', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    const body = (await response.json()) as { result: { instructions: string } }
    expect(body.result.instructions).toContain('never takes payment, adds to a cart')
    expect(body.result.instructions).not.toContain('create_cart_link')
    expect(chatgpt.GET().status).toBe(405)
    expect(chatgpt.DELETE().status).toBe(405)
  })
})
