import { HttpResponse, http } from 'msw'
import { createFakeSes } from '../e2e/support/fake-ses.mjs'
import { server } from './server'

/**
 * Amazon SES (eu-west-2) and the two public DNS-over-HTTPS resolvers, as the
 * unit tests meet them: MSW answers each request from one in-memory fake
 * (tests/e2e/support/fake-ses.mjs), so a test drives SES and DNS by changing
 * the fake — never by mocking our own code — and no test reaches AWS or a
 * resolver.
 */

export type FakeSes = ReturnType<typeof createFakeSes>

export const SES_ORIGIN = 'https://email.eu-west-2.amazonaws.com'

export function useFakeSes(): FakeSes {
  const fake = createFakeSes()
  server.use(
    http.all(`${SES_ORIGIN}/v2/email/*`, async ({ request }) => {
      const text =
        request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text()
      const url = new URL(request.url)
      const answer = fake.handle(request.method, url.pathname, text ? JSON.parse(text) : undefined)
      return HttpResponse.json(answer.body, {
        status: answer.status,
        headers: answer.errorType ? { 'x-amzn-errortype': answer.errorType } : {},
      })
    }),
  )
  return fake
}

export const DOH_URLS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']

/** Both resolvers answer from the fake's DNS; `down` makes them fail. */
export function useFakeDoh(fake: FakeSes, { down = false }: { down?: boolean } = {}) {
  const asked: string[] = []
  for (const url of DOH_URLS) {
    server.use(
      http.get(url, ({ request }) => {
        const query = new URL(request.url).searchParams
        asked.push(`${query.get('type')} ${query.get('name')}`)
        if (down) return HttpResponse.json({ error: 'down' }, { status: 502 })
        return HttpResponse.json(fake.resolve(query.get('name') ?? '', query.get('type') ?? ''))
      }),
    )
  }
  return asked
}
