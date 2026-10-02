import { describe, expect, it } from 'vitest'
import { certificateFiles, csrFileName, fileBase, keyFileName } from '../lib/files'
import { toSslOffers } from '../lib/offers'
import { approvalDomain, certificateState, daysLeft, setupProblem } from '../lib/status'

const NOW = new Date('2026-10-02T12:00:00Z')

const product = (code: string, over: Record<string, unknown> = {}) => ({
  productCode: code,
  name: `Product ${code}`,
  vendor: 'Sectigo',
  validationType: 'DV',
  isWildcard: false,
  isMultiDomain: false,
  includedNames: 1,
  isReissueFree: true,
  createUsd: 6.99,
  price: { costKobo: 1, priceKobo: 1_350_000, marginKobo: 1 },
  ...over,
})

describe('how a certificate reads (FR-SSL-7)', () => {
  it.each([
    ['pending', 'Ordering', 'waiting', true],
    ['awaiting_setup', 'Set it up', 'action', false],
    ['setting_up', 'Sending set-up', 'waiting', true],
    ['awaiting_validation', 'Waiting for approval', 'action', true],
    ['issued', 'Issued', 'good', false],
    ['reissuing', 'Reissuing', 'waiting', true],
    ['revoked', 'Revoked', 'problem', false],
    ['cancelled', 'Cancelled', 'problem', false],
    ['failed', 'Not ordered', 'problem', false],
  ])('%s → %s', (status, label, tone, settling) => {
    expect(certificateState(status, '2027-01-01T00:00:00Z', NOW)).toEqual({ label, tone, settling })
  })

  it('calls an issued certificate past its date expired, and an unknown status by its name', () => {
    expect(certificateState('issued', '2026-10-01T00:00:00Z', NOW)).toMatchObject({
      label: 'Expired',
      tone: 'problem',
    })
    expect(certificateState('issued', null, NOW).label).toBe('Issued')
    expect(certificateState('mystery', null, NOW)).toMatchObject({
      label: 'mystery',
      settling: false,
    })
  })

  it('counts the days left, never below none', () => {
    expect(daysLeft('2026-10-12T12:00:00Z', NOW)).toBe(10)
    expect(daysLeft('2026-09-01T00:00:00Z', NOW)).toBe(0)
    expect(daysLeft(null, NOW)).toBeNull()
  })

  it('says what to do about a refused set-up, in our words (N10)', () => {
    expect(setupProblem('CSR_NAME_MISMATCH')).toMatch(/different name/)
    expect(setupProblem('SSL_INVALID_REQUEST')).toMatch(/20 characters/)
    expect(setupProblem('Ssl:99999')).toMatch(/did not accept it/)
    expect(setupProblem(null)).toBeNull()
  })

  it('names the approval domain without the wildcard', () => {
    expect(approvalDomain('*.example.com')).toBe('example.com')
    expect(approvalDomain('shop.example.com')).toBe('shop.example.com')
  })
})

describe('the files a customer takes away', () => {
  const PEM = '-----BEGIN CERTIFICATE-----\r\nMIIF\r\n-----END CERTIFICATE-----'
  const CHAIN = '-----BEGIN CERTIFICATE-----\nMIIChain\n-----END CERTIFICATE-----\n'

  it('names files without a * in them', () => {
    expect(fileBase('*.example.com')).toBe('wildcard.example.com')
    expect(keyFileName('*.example.com')).toBe('wildcard.example.com.key')
    expect(csrFileName('example.com')).toBe('example.com.csr')
  })

  it('offers the certificate, the chain, and both in one file', () => {
    const files = certificateFiles('example.com', PEM, CHAIN)
    expect(files.map((file) => file.name)).toEqual([
      'example.com.crt',
      'example.com.ca-bundle',
      'example.com-fullchain.pem',
    ])
    expect(files[0]?.content).toBe('-----BEGIN CERTIFICATE-----\nMIIF\n-----END CERTIFICATE-----\n')
    expect(files[2]?.content).toBe(`${files[0]?.content}${CHAIN}`)
  })

  it('offers only the certificate without a chain, and nothing before it is issued', () => {
    expect(certificateFiles('example.com', PEM, null).map((file) => file.name)).toEqual([
      'example.com.crt',
    ])
    expect(certificateFiles('example.com', null, CHAIN)).toEqual([])
    expect(certificateFiles('example.com', '  ', CHAIN)).toEqual([])
  })
})

describe('the storefront offers (FR-SSL-1)', () => {
  it('orders one name, several names, then the wildcard, and words each with its term and N8 renewal', () => {
    const offers = toSslOffers([
      product('352', {
        isWildcard: true,
        price: { costKobo: 1, priceKobo: 13_500_000, marginKobo: 1 },
      }),
      product('371', {
        isMultiDomain: true,
        includedNames: 4,
        price: { costKobo: 1, priceKobo: 5_900_000, marginKobo: 1 },
      }),
      product('351'),
    ] as never)
    expect(offers.map((offer) => [offer.productCode, offer.kind])).toEqual([
      ['351', 'single'],
      ['371', 'multi'],
      ['352', 'wildcard'],
    ])
    expect(offers[0]).toMatchObject({
      price: '₦13,500',
      term: '1-year subscription',
      nameLabel: 'The name it is for',
    })
    expect(offers[0]?.renewal).toMatch(/never renews by itself.*₦13,500 at today’s price/)
    expect(offers[1]?.covers).toMatch(/Up to 4 names under one domain/)
    expect(offers[2]?.covers).toMatch(/\*\.example\.com/)
    expect(offers[2]?.nameLabel).toBe('Your domain')
  })
})
