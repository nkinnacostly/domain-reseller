import { HttpResponse, http } from 'msw'
import { createFakeCloudflare } from '../e2e/support/fake-cloudflare.mjs'
import { server } from './server'
import type { FakeSes } from './ses'

/**
 * Cloudflare's API as the unit tests meet it (MAIL-SPEC §5.3): MSW answers
 * every request to api.cloudflare.com/client/v4 from one in-memory fake
 * (tests/e2e/support/fake-cloudflare.mjs). Given the fake SES, the records it
 * makes appear in the fake public DNS too.
 */

export type FakeCloudflare = ReturnType<typeof createFakeCloudflare>

export const CLOUDFLARE_ORIGIN = 'https://api.cloudflare.com'

export function useFakeCloudflare(dns?: FakeSes): FakeCloudflare {
  const fake = createFakeCloudflare(dns ? { dns } : {})
  server.use(
    http.all(`${CLOUDFLARE_ORIGIN}/client/v4/*`, async ({ request }) => {
      const url = new URL(request.url)
      const text = request.method === 'GET' ? '' : await request.text()
      const answer = fake.handle(
        request.method,
        url.pathname,
        url.searchParams,
        text ? JSON.parse(text) : undefined,
        request.headers.get('authorization') ?? '',
      )
      return HttpResponse.json(answer.body, { status: answer.status })
    }),
  )
  return fake
}
