import { createServer, type Server } from 'node:http'

/**
 * Fly's health check: `GET /health` answers 200 while the SMTP listener is
 * up, 503 otherwise — Fly then restarts the machine. It says nothing else,
 * to anyone, and is not one of the ports Fly exposes.
 */
export function startHealthServer(port: number, healthy: () => boolean): Server {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      const ok = healthy()
      response.writeHead(ok ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      response.end(JSON.stringify({ ok }))
      return
    }
    response.writeHead(404).end()
  })
  server.listen(port)
  return server
}
