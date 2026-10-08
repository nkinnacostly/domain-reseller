import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { startHealthServer } from './health'

describe('the health check', () => {
  it('answers 200 while the relay listens, 503 when it does not, 404 to anything else', async () => {
    let up = true
    const server = startHealthServer(0, () => up)
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/health`)).status).toBe(200)
    up = false
    const down = await fetch(`${base}/health`)
    expect(down.status).toBe(503)
    expect(await down.json()).toEqual({ ok: false })
    expect((await fetch(`${base}/`)).status).toBe(404)
    await new Promise((resolve) => server.close(resolve))
  })
})
