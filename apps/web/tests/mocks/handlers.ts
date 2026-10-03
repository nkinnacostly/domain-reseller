import { HttpResponse, http } from 'msw'
import { SNS_HOST, snsPublicKeyPem } from './sns'

const READ_AT = '2026-10-03T11:05:00.000Z'

/**
 * The gateway's `/v1/admin/*` routes (ADMIN-SPEC §4.3, §8.1), answering as
 * the gateway does after it claims the note — with no personal data: ids,
 * names, states, amounts in cents or kobo. A request without the admin
 * headers is refused, as the gateway refuses it.
 */
function adminHandlers() {
  const admin = (
    method: 'get' | 'post',
    path: string,
    data: (params: Record<string, string>, url: URL) => unknown,
  ) =>
    http[method](`*/v1/admin/${path}`, ({ request, params }) => {
      if (
        !request.headers.get('x-admin-secret') ||
        !/^\d+$/.test(request.headers.get('x-admin-audit-id') ?? '') ||
        !request.headers.get('x-admin-label')
      ) {
        return HttpResponse.json(
          {
            ok: false,
            code: 'VALIDATION_FAILED',
            message: 'An audit note and an admin are required',
          },
          { status: 400 },
        )
      }
      const url = new URL(request.url)
      return HttpResponse.json({
        ok: true,
        data: data(params as Record<string, string>, url),
      })
    })
  const side = (url: URL) => (url.searchParams.get('side') === 'live' ? 'live' : 'test')

  return [
    admin('get', 'supplier/balance', (_, url) => ({
      side: side(url),
      balanceCents: 4338,
      priceGroup: null,
      readAt: READ_AT,
    })),
    admin('get', 'supplier/transactions', (_, url) => ({
      side: side(url),
      total: 0,
      items: [],
      readAt: READ_AT,
    })),
    admin('get', 'supplier/domains', (_, url) => ({
      side: side(url),
      total: 0,
      items: [],
      readAt: READ_AT,
    })),
    admin('get', 'supplier/domains/:name', ({ name = '' }) => ({
      name,
      outcome: 'not_found',
      status: null,
      statusCode: null,
      expiresAt: null,
      rgpExpiresAt: null,
      transferLock: null,
      privacy: null,
      nameservers: [],
      readAt: READ_AT,
    })),
    admin('get', 'supplier/domains/:name/verification', ({ name = '' }) => ({
      name,
      isVerified: true,
      operationStatus: null,
      verifiedAt: null,
      fieldType: 'Email',
      readAt: READ_AT,
    })),
    admin('get', 'supplier/domains/:name/transfer', ({ name = '' }) => ({
      name,
      state: 'pending',
      supplierStatus: 'pending',
      requestedAt: null,
      finalAt: null,
      readAt: READ_AT,
    })),
    admin('get', 'supplier/domains/:name/renewable', ({ name = '' }) => ({
      name,
      renewable: true,
      renewalLock: false,
      reasonKey: null,
      readAt: READ_AT,
    })),
    admin('get', 'supplier/prices/:tld', ({ tld = '' }, url) => ({
      tld,
      op: url.searchParams.get('op') ?? 'register',
      years: Number(url.searchParams.get('years') ?? 1),
      supplierCents: 1131,
      ourCents: 1131,
      matches: true,
      readAt: READ_AT,
    })),
    ...(['catalogue', 'ssl-catalogue'] as const).flatMap((kind) => [
      admin('get', `supplier/${kind}/preview`, () => ({
        kind: kind === 'ssl-catalogue' ? 'ssl' : 'tlds',
        outcome: 'ok',
        reason: null,
        listed: 0,
        sellable: 0,
        changes: 0,
        report: [],
        readAt: READ_AT,
      })),
      admin('post', `supplier/${kind}/apply`, () => ({
        outcome: 'refused',
        reason: 'NOT_PRODUCTION',
        changes: 0,
        readAt: READ_AT,
      })),
    ]),
    admin('get', 'supplier/ssl/:name', ({ name = '' }) => ({
      name,
      outcome: 'not_found',
      status: null,
      isConfigured: null,
      isIssued: null,
      certificateExpiresAt: null,
      subscriptionEndsAt: null,
      validUntil: null,
      readAt: READ_AT,
    })),
    admin('get', 'flutterwave/refunds/:flwRefundId', ({ flwRefundId = '' }) => ({
      checkId: 1,
      flwRefundId,
      transactionId: '456',
      amountKobo: 1967250,
      status: 'completed',
      state: 'done',
      readAt: READ_AT,
    })),
    admin('post', 'presets/drafts/:id/check', () => ({
      ok: true,
      hosts: [],
      checkedAt: READ_AT,
    })),
  ]
}

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

  ...adminHandlers(),

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
