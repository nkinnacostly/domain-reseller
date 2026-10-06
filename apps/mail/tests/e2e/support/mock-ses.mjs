/**
 * The e2e suite's Amazon SES and public DNS (MAIL-SPEC §12: no e2e test ever
 * calls real SES or a real resolver). Playwright starts it beside the app
 * (playwright.config.ts); the app reaches it through MAIL_SES_ENDPOINT and
 * MAIL_DOH_URL, which only accept this machine and are refused in
 * production. Running this file starts the server — never import it from a
 * spec; a spec drives it over HTTP:
 *
 *   POST /__control/verify?domain=   SES verifies it, and its records are in DNS
 *   POST /__control/publish?domain=  its records are in DNS, SES has not looked
 *   GET  /__control/identity?domain= 200 with SES's view of it, or 404
 *   GET  /__health                   200
 */
import { createServer } from 'node:http'
import { createFakeSes } from './fake-ses.mjs'

const port = Number(process.env.MOCK_SES_PORT ?? 4312)
const fake = createFakeSes()

/** @param {import('node:http').IncomingMessage} request */
function readBody(request) {
  return new Promise((resolve) => {
    let text = ''
    request.on('data', (chunk) => {
      text += chunk
    })
    request.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : undefined)
      } catch {
        resolve(undefined)
      }
    })
  })
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body ?? {}))
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
  const domain = url.searchParams.get('domain') ?? ''

  if (url.pathname === '/__health') return send(response, 200, { ok: true })
  if (url.pathname === '/dns-query') {
    return send(
      response,
      200,
      fake.resolve(url.searchParams.get('name') ?? '', url.searchParams.get('type') ?? ''),
    )
  }
  if (url.pathname === '/__control/verify' && request.method === 'POST') {
    fake.publishRecords(domain)
    return send(response, fake.verify(domain) ? 200 : 404, { ok: true })
  }
  if (url.pathname === '/__control/publish' && request.method === 'POST') {
    fake.publishRecords(domain)
    return send(response, 200, { ok: true })
  }
  if (url.pathname === '/__control/identity') {
    const identity = fake.identities.get(domain)
    return identity ? send(response, 200, identity) : send(response, 404, { ok: false })
  }
  if (url.pathname.startsWith('/v2/email/')) {
    // The request's path still encoded, as SES receives it.
    const rawPath = (request.url ?? '').split('?')[0] ?? ''
    const body = await readBody(request)
    const answer = fake.handle(request.method ?? 'GET', rawPath, body)
    return send(
      response,
      answer.status,
      answer.body,
      answer.errorType ? { 'x-amzn-errortype': answer.errorType } : {},
    )
  }
  return send(response, 404, { message: 'the mock SES has no such path' })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock SES and DNS on http://127.0.0.1:${port}\n`)
})
