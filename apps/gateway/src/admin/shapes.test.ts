import { describe, expect, it } from 'vitest'
import {
  errorCode,
  sellingCents,
  toBalance,
  toLedgerEntry,
  toRegistryListing,
  toRenewCheck,
  toTransferState,
  toVerification,
  transferWord,
} from './shapes'

/**
 * ADMIN-SPEC §4.2: answers are built field by field. Sentinels stand in for
 * personal data the supplier sends; none may survive a projection.
 */

const SENTINEL = 'SENTINEL-PII-7f3a'
const READ_AT = '2026-10-02T12:00:00.000Z'

const leaks = (value: unknown) => JSON.stringify(value).includes(SENTINEL)

describe('admin projections', () => {
  it('keeps the balance in cents and drops the reseller’s name', () => {
    const balance = toBalance(
      {
        resellerId: SENTINEL,
        resellerName: SENTINEL,
        resellerGroupName: 'Reseller',
        tryBalance: 1,
        usdBalance: 43.38,
      },
      'live',
      READ_AT,
    )
    expect(balance).toEqual({
      side: 'live',
      balanceCents: 4338,
      priceGroup: 'Reseller',
      readAt: READ_AT,
    })
    expect(leaks(balance)).toBe(false)
    expect(toBalance({}, 'live', READ_AT)).toBeNull()
  })

  it('turns a ledger entry into cents from the balances, never the amount', () => {
    const entry = toLedgerEntry({
      traceId: 'A476642F-9956-7CE2-9B08-3A23E027661E',
      creationTime: '2026-09-23T14:15:46.53',
      type: 1,
      status: 1,
      chargeType: 1,
      productType: 1,
      period: 1,
      amount: 0,
      oldBalance: 15.0,
      balance: 3.69,
      description: 'mydomainshub.com',
      resellerName: SENTINEL,
      exchangeAmount: SENTINEL,
    })
    expect(entry).toEqual({
      traceId: 'a476642f-9956-7ce2-9b08-3a23e027661e',
      // Zoneless supplier time is UTC+3.
      occurredAt: '2026-09-23T11:15:46.530Z',
      type: 1,
      status: 1,
      chargeType: 1,
      productType: 1,
      description: 'mydomainshub.com',
      period: 1,
      deltaCents: -1131,
      balanceBeforeCents: 1500,
      balanceAfterCents: 369,
      kind: 'domain_charge',
    })
    expect(leaks(entry)).toBe(false)
    expect(
      toLedgerEntry({ traceId: 'nope', creationTime: '2026-09-23T14:15:46', type: 1 }),
    ).toBeNull()
    expect(
      toLedgerEntry({
        traceId: 'a476642f-9956-7ce2-9b08-3a23e027661e',
        creationTime: '2026-09-23T14:15:46',
        type: 1,
        status: 1,
        chargeType: 1,
        productType: 1,
      }),
    ).toBeNull()
  })

  it('lists a domain without its contacts', () => {
    const listing = toRegistryListing({
      domainName: 'Example.com',
      status: 0,
      expirationDate: '2027-09-23T13:44:14.8005439',
      rgpExpirationDate: null,
      lockStatus: true,
      privacyProtectionStatus: false,
      renewalMode: 'AutoRenew',
      contacts: { Registrant: SENTINEL, Admin: SENTINEL },
      nameservers: [{ name: 'NS1.DomainNameAPI.com', isLinked: true }],
    })
    expect(listing).toEqual({
      name: 'example.com',
      status: 'Active',
      expiresAt: '2027-09-23T10:44:14.800Z',
      rgpExpiresAt: null,
      transferLock: true,
      privacy: false,
      renewalModeLabel: 'AutoRenew',
      nameservers: ['ns1.domainnameapi.com'],
    })
    expect(leaks(listing)).toBe(false)
    expect(toRegistryListing({})).toBeNull()
  })

  it('says whether the registrant verified, never what or who', () => {
    const verification = toVerification(
      {
        results: [
          {
            ownerName: SENTINEL,
            fieldValue: SENTINEL,
            fieldType: 'Email',
            operationStatus: 'Completed',
            userVerificationDate: '2026-09-20T08:48:08.52857+03:00',
            isUserVerified: true,
          },
        ],
      },
      'example.com',
      READ_AT,
    )
    expect(verification).toEqual({
      name: 'example.com',
      isVerified: true,
      operationStatus: 'Completed',
      verifiedAt: '2026-09-20T05:48:08.528Z',
      fieldType: 'Email',
      readAt: READ_AT,
    })
    expect(leaks(verification)).toBe(false)
    expect(toVerification({ results: [] }, 'example.com', READ_AT)).toBeNull()
  })

  it('maps transfer statuses, and nothing unknown to a refusal', () => {
    expect(transferWord('pending')).toBe('pending')
    expect(transferWord('clientApproved')).toBe('completed')
    expect(transferWord('serverApproved')).toBe('completed')
    expect(transferWord('clientRejected')).toBe('rejected')
    expect(transferWord('client_cancelled')).toBe('cancelled')
    expect(transferWord('serverCancelled')).toBe('cancelled')
    expect(transferWord('Mystery')).toBe('unknown')
    expect(transferWord(null)).toBe('unknown')
    const state = toTransferState(
      {
        domainName: 'example.com',
        status: 'clientRejected',
        requestedDate: '2026-09-28T10:00:00',
        finalDate: null,
        requestedClientId: SENTINEL,
      },
      'example.com',
      READ_AT,
    )
    expect(state).toMatchObject({
      state: 'rejected',
      supplierStatus: 'clientRejected',
      requestedAt: '2026-09-28T07:00:00.000Z',
    })
    expect(leaks(state)).toBe(false)
  })

  it('keys a renew-check refusal, never the supplier’s words', () => {
    // OTE, 2 Oct 2026: period 1 renewable; period 10 refused with Domain:1016.
    expect(
      toRenewCheck(
        { renewabilityStatus: true, renewalLock: false, errorMessageKey: null },
        'x.com',
        READ_AT,
      ),
    ).toEqual({
      name: 'x.com',
      renewable: true,
      renewalLock: false,
      reasonKey: null,
      readAt: READ_AT,
    })
    expect(
      toRenewCheck(
        {
          renewabilityStatus: false,
          renewalLock: false,
          errorMessageKey: 'Dna.DomainService:Domain:1016',
        },
        'x.com',
        READ_AT,
      ).reasonKey,
    ).toBe('PERIOD_NOT_ALLOWED')
    expect(
      toRenewCheck({ renewabilityStatus: false, errorMessageKey: 'Other:1' }, 'x.com', READ_AT)
        .reasonKey,
    ).toBe('NOT_RENEWABLE')
  })

  it('reads a selling price in cents, USD only', () => {
    expect(sellingCents({ sellingPrice: 11.31, sellingCurrency: 'USD' })).toBe(1131)
    expect(sellingCents({ sellingPrice: 199.8 })).toBe(19980)
    expect(sellingCents({ sellingPrice: 5, sellingCurrency: 'TRY' })).toBeNull()
    expect(sellingCents({ sellingPrice: 'abc' })).toBeNull()
    expect(sellingCents({})).toBeNull()
  })

  it('reads a supplier error code', () => {
    expect(
      errorCode({ error: { code: 'Dna.DomainService:Domain:10025', message: SENTINEL } }),
    ).toBe('Dna.DomainService:Domain:10025')
    expect(errorCode(null)).toBeNull()
  })
})
