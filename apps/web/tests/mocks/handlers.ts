import { HttpResponse, http } from 'msw'

/**
 * Default network doubles. Tests override per-case with `server.use(...)`.
 * Every outbound call the app can make should have a handler here so an
 * unhandled request is a genuine signal, not noise.
 */
export const handlers = [
  // Registrar gateway — availability
  http.post('*/v1/availability', async ({ request }) => {
    const body = (await request.json()) as { query: string; tlds: string[] }
    return HttpResponse.json({
      ok: true,
      data: body.tlds.map((tld, index) => ({
        domainName: `${body.query}.${tld}`,
        tld,
        available: index % 2 === 0,
        isPremium: false,
        priceKobo: 1_750_000,
        renewalPriceKobo: 1_950_000,
      })),
    })
  }),

  // Registrar gateway — account balance
  http.get('*/v1/account/balance', () =>
    HttpResponse.json({ ok: true, data: { balance: 5000, currency: 'USD' } }),
  ),

  // Gateway health
  http.get('*/health', () => HttpResponse.json({ ok: true, data: { status: 'healthy' } })),
]
