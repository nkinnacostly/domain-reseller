import { createServer, type Server } from 'node:http'

/**
 * Fly's health check: `GET /health` answers 200 while the send loop has run
 * recently, 503 once it has been silent too long — Fly then restarts the one
 * machine (§11). It says nothing else, to anyone.
 */
export function healthStatus(lastRunAt: number | null, now: number, staleAfterMs: number): number {
  return lastRunAt !== null && now - lastRunAt <= staleAfterMs ? 200 : 503
}

export function startHealthServer(port: number, status: () => number): Server {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      const code = status()
      response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: code === 200 }))
      return
    }
    response.writeHead(404).end()
  })
  server.listen(port)
  return server
}
