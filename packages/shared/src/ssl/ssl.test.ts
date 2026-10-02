import { describe, expect, it } from 'vitest'
import { KOBO_PER_NAIRA, type PricingInputs, priceFor, retailFromUsd } from '../pricing/index'
import {
  bareName,
  containsPrivateKey,
  extraNamesProblem,
  namesBase,
  priceSslProducts,
  readCsr,
  SSL_TERM,
  type SslProductRecord,
  sslContactSchema,
  sslHostnameSchema,
  supplierName,
} from './index'

const inputs: PricingInputs = { fxRate: 1500, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }

const product = (overrides: Partial<SslProductRecord> = {}): SslProductRecord => ({
  productCode: '351',
  name: 'Sectigo PositiveSSL Certificate',
  vendor: 'Sectigo',
  validationType: 'DV',
  isWildcard: false,
  isMultiDomain: false,
  includedNames: 1,
  isReissueFree: true,
  createUsd: 6.99,
  ...overrides,
})

/** A real CSR for shop.example.com, made with openssl for these tests; its key was thrown away. */
const CSR_FIXTURE = `-----BEGIN CERTIFICATE REQUEST-----
MIICozCCAYsCAQAwXjELMAkGA1UEBhMCTkcxDjAMBgNVBAgMBUxhZ29zMQ4wDAYD
VQQHDAVJa2VqYTEUMBIGA1UECgwLRXhhbXBsZSBMdGQxGTAXBgNVBAMMEHNob3Au
ZXhhbXBsZS5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC9hSuY
3HzcoWEIQAB++3IH4d8bjDVlfqyvHa3GPG/Kt4w15sRDRXxVhtksc1YL0hvyW7Hz
Rqns0zEfC8oFD2zp6Gb/O4QEbC14iHgRt2M9T0dPINq325GoQf0gpZU+sIQP/aha
5V8AfVIV6KWJzoeruBqrPt0Zc7b8I9DR3k555qCVRW4hUI0NRe7ZfWNlXw4LS6jL
+YdBuXX0wWgftv+8Z0TlSPhQRTsvg5ro8PxX/wbcpvsJXVgs3lY3xubS8xICGiGu
mp9BoQsSnxqSV5XNu8uBp7qo5mROp8NOH+Z45iuhMa7nN9C3c1wipNuDt45yxSdg
Q3T58Weta5FsxsUDAgMBAAGgADANBgkqhkiG9w0BAQsFAAOCAQEAFu4YVUNesJAs
IQ3AVgQatAeh1RrF/IIUmBadrLeGxBg0KpDxo9hHbItujGMfVXAxZfReuLRdVpMu
EK8m/+DHoiv3jVI4uywcSJOwx7+g9d0Ll3PxMH3IgY90ruXvk0unwD+l+z0YxG2U
lM8SS9wnkDuAihKitG3auTfDWAo3eIYOtBoodQwI4y58063cD2qDxN9zt87RFO7y
Ut62XeGm7x3UytrVrafY+G1LFin7WEu1QT43gYvXqs1hQd0uuE4gsswCSJLBRBww
XoVuIScde4t+K4/3btdW+oEEll9s/y1CzKG4Mr3E/LSWmPSzI65eYh+yojLMRGU7
Ge93y+vuTg==
-----END CERTIFICATE REQUEST-----`

describe('SSL pricing (FR-SSL-2, N5b)', () => {
  it('builds a certificate price exactly as a domain’s, with no ICANN fee', () => {
    const [priced] = priceSslProducts([product()], inputs)
    // 6.99 × 1500 = ₦10,485, + ₦3,000 = ₦13,485 → ₦13,500.
    expect(priced?.price.costKobo).toBe(1_048_500)
    expect(priced?.price.priceKobo).toBe(1_350_000)
    expect(priced?.price.marginKobo).toBe(1_350_000 - 1_048_500)
    // The same number the domain engine gives a fee-free extension of that cost.
    const asDomain = priceFor(
      {
        name: 'x',
        registerUsd: 6.99,
        renewUsd: 6.99,
        transferUsd: null,
        restoreUsd: null,
        isCountryCode: true,
      },
      'registration',
      inputs,
    )
    expect(asDomain?.priceKobo).toBe(priced?.price.priceKobo)
  })

  it('never sells below the margin, and only rounds up', () => {
    for (const usd of [6.99, 36.99, 87.99, 0.01, 1234.56]) {
      const [priced] = priceSslProducts([product({ createUsd: usd })], inputs)
      expect(priced?.price.marginKobo).toBeGreaterThanOrEqual(3000 * KOBO_PER_NAIRA)
      expect((priced?.price.priceKobo ?? 0) % (100 * KOBO_PER_NAIRA)).toBe(0)
    }
  })

  it('applies the FX buffer the domain engine applies', () => {
    const buffered = { ...inputs, fxBufferPct: 4 }
    const [priced] = priceSslProducts([product({ createUsd: 87.99 })], buffered)
    expect(priced?.price.costKobo).toBe(Math.round(87.99 * 1560 * 100))
  })

  it('withholds a product the sync has not priced, or priced at nothing', () => {
    expect(priceSslProducts([product({ createUsd: null })], inputs)).toEqual([])
    expect(priceSslProducts([product({ createUsd: 0 })], inputs)).toEqual([])
    expect(priceSslProducts([product({ createUsd: Number.NaN })], inputs)).toEqual([])
    expect(retailFromUsd(-1, inputs)).toBeNull()
  })

  it('refuses a broken rate rather than pricing with it', () => {
    expect(() => priceSslProducts([product()], { ...inputs, fxRate: 0 })).toThrow(RangeError)
  })

  it('states the term without promising a one-year certificate (N9b)', () => {
    expect(SSL_TERM.short).toBe('1-year subscription')
    expect(SSL_TERM.long).toMatch(/at most 200 days/)
    expect(SSL_TERM.long).not.toMatch(/valid for (one|1) year/i)
    expect(SSL_TERM.renewal('₦13,500')).toMatch(/never renews by itself.*₦13,500 at today’s price/)
  })
})

describe('certificate names', () => {
  it('takes a host, lower-cased and without a trailing dot', () => {
    expect(sslHostnameSchema.parse(' Shop.Example.COM. ')).toBe('shop.example.com')
    expect(sslHostnameSchema.parse('example.com.ng')).toBe('example.com.ng')
  })

  it.each([
    ['localhost', 'Include the extension'],
    ['*.example.com', 'Leave out the "*."'],
    ['exa mple.com', 'letters, numbers'],
    ['-bad.com', 'letters, numbers'],
    ['10.0.0.1', 'not an IP address'],
    ['a.b', 'full name'],
  ])('refuses %s', (value, message) => {
    const result = sslHostnameSchema.safeParse(value)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toContain(message)
  })

  it('names a wildcard *.host at the supplier, and anything else by its host', () => {
    expect(supplierName('example.com', true)).toBe('*.example.com')
    expect(supplierName('example.com', false)).toBe('example.com')
    expect(bareName('*.example.com')).toBe('example.com')
    expect(bareName('shop.example.com')).toBe('shop.example.com')
  })

  it('puts extra names under the main name’s domain, without its www', () => {
    expect(namesBase('www.example.com')).toBe('example.com')
    expect(namesBase('*.example.com')).toBe('example.com')
    expect(namesBase('shop.example.com')).toBe('shop.example.com')
    // A two-label www is a domain called www, not a prefix.
    expect(namesBase('www.ng')).toBe('www.ng')
  })
})

describe('extra names on a multi-domain certificate (FR-SSL-5)', () => {
  it('accepts names under the main domain, up to what is included', () => {
    expect(
      extraNamesProblem(
        'example.com',
        ['www.example.com', 'shop.example.com', 'mail.example.com'],
        4,
      ),
    ).toBeNull()
    expect(extraNamesProblem('www.example.com', ['example.com', 'api.example.com'], 4)).toBeNull()
  })

  it('refuses more names than the certificate covers', () => {
    expect(extraNamesProblem('example.com', ['a.example.com', 'b.example.com'], 2)).toMatch(
      /covers 2 names in all/,
    )
    expect(extraNamesProblem('example.com', ['a.example.com'], 1)).toMatch(/covers 1 names/)
  })

  it('refuses a name under another domain: one approver cannot approve it', () => {
    expect(extraNamesProblem('example.com', ['example.ng'], 4)).toMatch(/not under example.com/)
    expect(extraNamesProblem('example.com', ['notexample.com'], 4)).toMatch(/not under/)
  })

  it('refuses duplicates, the main name again, and things that are not names', () => {
    expect(extraNamesProblem('example.com', ['a.example.com', 'A.example.com'], 4)).toMatch(
      /listed twice/,
    )
    expect(extraNamesProblem('example.com', ['example.com'], 4)).toMatch(/listed twice/)
    expect(extraNamesProblem('example.com', ['not a name'], 4)).toMatch(/^not a name:/)
  })
})

describe('reading a pasted CSR', () => {
  it('accepts a CSR, tidying Windows line ends and stray spaces', () => {
    const messy = `  ${CSR_FIXTURE.replace(/\n/g, '\r\n')}  \r\n`
    const result = readCsr(messy)
    expect(result).toEqual({ ok: true, csr: CSR_FIXTURE })
  })

  it('accepts the older NEW CERTIFICATE REQUEST markers', () => {
    const old = CSR_FIXTURE.replace(/CERTIFICATE REQUEST/g, 'NEW CERTIFICATE REQUEST')
    expect(readCsr(old).ok).toBe(true)
  })

  it('refuses text that is not a CSR', () => {
    expect(readCsr('hello').ok).toBe(false)
    expect(readCsr('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----').ok).toBe(false)
  })

  it('refuses anything with a private key in it, and says why (N13)', () => {
    const withKey = `${CSR_FIXTURE}\n-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----`
    const result = readCsr(withKey)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toMatch(/includes a private key/)
    expect(containsPrivateKey('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
    expect(containsPrivateKey('-----BEGIN EC PRIVATE KEY-----')).toBe(true)
    expect(containsPrivateKey(CSR_FIXTURE)).toBe(false)
  })
})

describe('the certificate contact', () => {
  const contact = {
    firstName: 'Ada',
    lastName: 'Okafor',
    email: 'ada@example.com',
    phoneCountryCode: '234',
    phone: '8031234567',
    addressLine1: '12 Admiralty Way',
    city: 'Lagos',
    state: 'Lagos',
    zipCode: '100001',
    country: 'NG',
  }

  it('takes our usual contact', () => {
    expect(sslContactSchema.safeParse(contact).success).toBe(true)
  })

  it('holds city, state and postcode to the supplier’s shorter limits', () => {
    const long = sslContactSchema.safeParse({
      ...contact,
      city: 'A city with a very long name',
      zipCode: '12345678901',
    })
    expect(long.success).toBe(false)
    expect(long.error?.issues.map((issue) => issue.path[0])).toEqual(['city', 'zipCode'])
  })
})
