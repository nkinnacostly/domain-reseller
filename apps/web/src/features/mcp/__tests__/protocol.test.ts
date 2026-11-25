import { describe, expect, it, vi } from 'vitest'
import { handleMcp, MCP_PROTOCOL_VERSIONS, type McpTool, RPC } from '../lib/protocol'

const echo: McpTool = {
  name: 'echo',
  title: 'Echo',
  description: 'Says it back',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
  run: vi.fn(async (args) => ({
    text: `said ${String(args.word)}`,
    structured: { word: args.word },
  })),
}
const broken: McpTool = {
  ...echo,
  name: 'broken',
  run: async () => Promise.reject(new Error('boom')),
}
const req = (method: string, params?: unknown, id: string | number = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
})

describe('handleMcp (feature 8)', () => {
  it('initializes with the version asked for when supported, else the newest', async () => {
    const asked = await handleMcp(req('initialize', { protocolVersion: '2025-06-18' }), [echo])
    expect(asked.body?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'mydomainshub' },
    })
    const unknown = await handleMcp(req('initialize', { protocolVersion: '1999-01-01' }), [echo])
    expect(unknown.body?.result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSIONS[0] })
  })

  it('lists tools without their code, answers ping, and accepts notifications with no body', async () => {
    const list = await handleMcp(req('tools/list'), [echo])
    expect(list.body?.result).toEqual({
      tools: [
        {
          name: 'echo',
          title: 'Echo',
          description: 'Says it back',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        },
      ],
    })
    expect((await handleMcp(req('ping', undefined, 'p'), [])).body).toEqual({
      jsonrpc: '2.0',
      id: 'p',
      result: {},
    })
    expect(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, [])).toEqual({
      status: 202,
      body: null,
    })
  })

  it('calls a tool, and turns a thrown error into a tool error the assistant can read', async () => {
    const call = await handleMcp(req('tools/call', { name: 'echo', arguments: { word: 'hi' } }), [
      echo,
      broken,
    ])
    expect(call.body?.result).toEqual({
      content: [{ type: 'text', text: 'said hi' }],
      structuredContent: { word: 'hi' },
      isError: false,
    })
    const failed = await handleMcp(req('tools/call', { name: 'broken' }), [echo, broken])
    expect(failed.body?.result).toMatchObject({ isError: true })
  })

  it('refuses what is not one well-formed request', async () => {
    expect((await handleMcp([req('ping')], [])).status).toBe(400)
    expect((await handleMcp({ id: 1, method: 'ping' }, [])).status).toBe(400)
    expect((await handleMcp({ jsonrpc: '2.0', id: {}, method: 'ping' }, [])).status).toBe(400)
    expect(
      (await handleMcp(req('tools/call', { name: 'nope' }), [echo])).body?.error,
    ).toMatchObject({ code: RPC.invalidParams })
    expect((await handleMcp(req('resources/list'), [])).body?.error).toMatchObject({
      code: RPC.methodNotFound,
    })
  })
})
