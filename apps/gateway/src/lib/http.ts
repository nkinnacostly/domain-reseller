import { request as httpsRequest } from 'node:https'

/**
 * JSON GET over HTTP/1.1.
 *
 * Node's fetch negotiates HTTP/2, which trips a TLS "bad record mac" against
 * the supplier's host. node:https stays on 1.1 and works everywhere.
 */
export function getJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'GET', headers: { Accept: 'application/json', ...headers }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error(`Non-JSON response: ${body.slice(0, 200)}`))
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}
