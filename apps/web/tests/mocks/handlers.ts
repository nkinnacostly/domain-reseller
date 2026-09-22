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

  // IANA RDAP bootstrap (RFC 9224). Trimmed to the registries the tests use;
  // `.co` is deliberately absent, as it is from the real file.
  http.get('https://data.iana.org/rdap/dns.json', () =>
    HttpResponse.json({
      version: '1.0',
      publication: '2026-09-16T19:00:03Z',
      services: [
        [['com', 'net'], ['https://rdap.test/verisign/']],
        [['org'], ['http://insecure.test/rdap/', 'https://rdap.test/pir/']],
      ],
    }),
  ),

  // A registry RDAP server: every domain exists, unlocked, registered long ago.
  // Tests override per case for locks, recent registrations and 404s.
  http.get('https://rdap.test/:registry/domain/:name', ({ params }) =>
    HttpResponse.json(
      {
        objectClassName: 'domain',
        ldhName: String(params.name).toUpperCase(),
        status: ['active'],
        events: [
          { eventAction: 'registration', eventDate: '2015-03-01T10:00:00Z' },
          { eventAction: 'expiration', eventDate: '2027-03-01T10:00:00Z' },
        ],
        entities: [
          {
            objectClassName: 'entity',
            roles: ['registrar'],
            vcardArray: [
              'vcard',
              [
                ['version', {}, 'text', '4.0'],
                ['fn', {}, 'text', 'Example Registrar Ltd'],
              ],
            ],
          },
        ],
      },
      { headers: { 'content-type': 'application/rdap+json' } },
    ),
  ),

  // Gateway health
  http.get('*/health', () => HttpResponse.json({ ok: true, data: { status: 'healthy' } })),
]
