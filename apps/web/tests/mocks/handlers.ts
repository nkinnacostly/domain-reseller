import { HttpResponse, http } from 'msw'
import { SNS_HOST, snsPublicKeyPem } from './sns'

/**
 * Default network doubles. Tests override per-case with `server.use(...)`.
 * Every outbound call the app can make should have a handler here so an
 * unhandled request is a genuine signal, not noise.
 */
export const handlers = [
  // Brevo transactional email (L1): accepted, as Brevo answers a good send.
  http.post('https://api.brevo.com/v3/smtp/email', () =>
    HttpResponse.json({ messageId: '<test@smtp-relay.mailin.fr>' }, { status: 201 }),
  ),

  // Amazon SES v2 SendEmail (L1, EMAIL_PROVIDER=ses): accepted, as SES answers.
  http.post('https://email.eu-west-2.amazonaws.com/v2/email/outbound-emails', () =>
    HttpResponse.json({ MessageId: '0102019a-test-4b7c-0000-000000000000-000000' }),
  ),

  // Amazon SNS: the signing certificate (the test key pair's public half, in
  // tests/mocks/sns.ts) and the subscription confirmation link.
  http.get(`https://${SNS_HOST}/:certificate`, ({ params }) =>
    String(params.certificate).endsWith('.pem')
      ? new HttpResponse(snsPublicKeyPem(), { headers: { 'content-type': 'text/plain' } })
      : new HttpResponse(null, { status: 404 }),
  ),
  http.get(`https://${SNS_HOST}/`, () =>
    HttpResponse.xml(
      '<ConfirmSubscriptionResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><ConfirmSubscriptionResult><SubscriptionArn>arn:aws:sns:eu-west-2:123456789012:mydomainshub-ses-events:test</SubscriptionArn></ConfirmSubscriptionResult></ConfirmSubscriptionResponse>',
    ),
  ),

  // Registrar gateway — availability, in the shared contract's shape. Every
  // pair is available unless a test overrides it.
  http.post('*/v1/availability', async ({ request }) => {
    const body = (await request.json()) as { names: string[]; tlds: string[] }
    return HttpResponse.json({
      ok: true,
      data: {
        results: body.names.flatMap((name) =>
          body.tlds.map((tld) => ({ name, tld, domain: `${name}.${tld}`, status: 'available' })),
        ),
      },
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

  // Registrar gateway — a domain's transfer code (FR-DS5). A made-up code;
  // tests override for the refusals.
  http.get('*/v1/domains/:name/auth-code', () =>
    HttpResponse.json({ ok: true, data: { authCode: 'test-transfer-code' } }),
  ),

  // Registrar gateway — the SSL set-up's reads (FR-SSL-4, /v1/ssl). The
  // approver list, the CA's reading of a CSR (for whatever name the test's
  // CSR names), and a generated key and CSR — a made-up key, never a real one.
  http.get('*/v1/ssl/approvers', ({ request }) => {
    const name = (new URL(request.url).searchParams.get('name') ?? '').replace(/^\*\./, '')
    return HttpResponse.json({
      ok: true,
      data: {
        emails: ['admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster'].map(
          (box) => `${box}@${name}`,
        ),
      },
    })
  }),
  http.post('*/v1/ssl/csr/check', () =>
    HttpResponse.json({
      ok: true,
      data: {
        commonName: 'shop.example.com',
        alternativeNames: [],
        isWildcard: false,
        organization: 'Example Ltd',
        country: 'NG',
      },
    }),
  ),
  http.post('*/v1/ssl/csr/generate', () =>
    HttpResponse.json({
      ok: true,
      data: {
        csr: '-----BEGIN CERTIFICATE REQUEST-----\nMIICtest\n-----END CERTIFICATE REQUEST-----',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEtestONLY\n-----END RSA PRIVATE KEY-----',
      },
    }),
  ),

  // Gateway health
  http.get('*/health', () => HttpResponse.json({ ok: true, data: { status: 'healthy' } })),

  // Cloudflare Turnstile siteverify (SEC-9): a person, as Cloudflare answers a
  // good token. Tests override per case for refusals and outages.
  http.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', () =>
    HttpResponse.json({
      success: true,
      'error-codes': [],
      challenge_ts: '2026-09-25T08:00:00.000Z',
      hostname: 'www.mydomainshub.com',
    }),
  ),
]
