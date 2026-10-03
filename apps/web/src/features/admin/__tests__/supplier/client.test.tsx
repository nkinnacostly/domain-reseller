import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyPriceList,
  applySslList,
  correctTopup,
  previewPriceList,
  previewSslList,
  recordTopup,
} from '@/features/admin/actions/supplier'
import {
  checkRenewable,
  checkSupplierPrice,
  lookupDomain,
  lookupSsl,
  readLiveBalance,
  readRegistrantVerification,
  readRegistryPage,
  readTransferState,
  searchLiveLedger,
} from '@/features/admin/actions/supplier-live'
import { CataloguePanel } from '@/features/admin/components/supplier/catalogue-panel'
import { LiveBalance } from '@/features/admin/components/supplier/live-balance'
import { LiveLedgerSearch } from '@/features/admin/components/supplier/live-ledger-search'
import {
  DomainLookup,
  PriceCheck,
  RegistryListing,
  SslLookup,
} from '@/features/admin/components/supplier/lookup-panels'
import { TopupAction } from '@/features/admin/components/supplier/topup-action'
import { SERVER_CRASH_WORDS } from '@/features/admin/lib/errors'
import { preview, TRACE } from './fixtures'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/actions/supplier', () => ({
  previewPriceList: vi.fn(),
  previewSslList: vi.fn(),
  applyPriceList: vi.fn(),
  applySslList: vi.fn(),
  recordTopup: vi.fn(),
  correctTopup: vi.fn(),
}))
vi.mock('@/features/admin/actions/supplier-live', () => ({
  readLiveBalance: vi.fn(),
  searchLiveLedger: vi.fn(),
  lookupDomain: vi.fn(),
  readRegistryPage: vi.fn(),
  readRegistrantVerification: vi.fn(),
  readTransferState: vi.fn(),
  checkRenewable: vi.fn(),
  checkSupplierPrice: vi.fn(),
  lookupSsl: vi.fn(),
}))

const READ_AT = '2026-10-03T11:05:00.000Z'

/** A safe-action answer carrying an admin result. */
const answer = (data: unknown) => ({ data }) as never

beforeEach(() => vi.clearAllMocks())

describe('LiveBalance', () => {
  it('reads on a press only, and shows the read beside the snapshot with its audit id', async () => {
    vi.mocked(readLiveBalance).mockResolvedValue(
      answer({
        ok: true,
        auditId: 41,
        data: { side: 'live', balanceCents: 3207, priceGroup: null, readAt: READ_AT },
      }),
    )
    const user = userEvent.setup()
    render(<LiveBalance snapshotCents={4338} takenAt="2026-10-03T11:00:00.000Z" />)
    expect(readLiveBalance).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Read live balance' }))
    expect(await screen.findByText(/^\$32\.07 at /)).toHaveTextContent(
      /12:05 WAT on live \(snapshot 12:00: \$43\.38\)$/,
    )
    expect(screen.getByText(/\$11\.31 lower than the latest snapshot/)).toBeInTheDocument()
    expect(screen.getByText('Audit entry #41')).toBeInTheDocument()
  })

  it('shows a refusal in words, and a lost answer as one', async () => {
    vi.mocked(readLiveBalance).mockResolvedValueOnce(
      answer({
        ok: false,
        code: 'WRITES_OFF',
        message: 'No gateway is reading this side right now.',
      }),
    )
    vi.mocked(readLiveBalance).mockRejectedValueOnce(new Error('network'))
    const user = userEvent.setup()
    render(<LiveBalance snapshotCents={null} takenAt={null} />)
    await user.click(screen.getByRole('button', { name: 'Read live balance' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No gateway is reading this side right now.',
    )
    await user.click(screen.getByRole('button', { name: 'Read live balance' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't reach")
  })
})

describe('LiveLedgerSearch', () => {
  it('posts what was typed — never in the address — and lists what DomainNameAPI holds', async () => {
    vi.mocked(searchLiveLedger).mockResolvedValue(
      answer({
        ok: true,
        auditId: 43,
        data: {
          side: 'test',
          total: 30,
          readAt: READ_AT,
          items: [
            {
              traceId: TRACE,
              occurredAt: READ_AT,
              type: 2,
              status: 1,
              chargeType: 1,
              productType: 1,
              description: 'example.com',
              period: 1,
              deltaCents: -1131,
              balanceBeforeCents: 4338,
              balanceAfterCents: 3207,
              kind: 'domain_charge',
            },
          ],
        },
      }),
    )
    const user = userEvent.setup()
    render(<LiveLedgerSearch />)
    const form = screen.getByRole('form', { name: 'Search the live ledger' })
    await user.type(within(form).getByLabelText('Description contains'), 'example')
    await user.type(within(form).getByLabelText('From'), '2026-10-01')
    await user.click(within(form).getByRole('button', { name: 'Search the live ledger' }))
    expect(searchLiveLedger).toHaveBeenCalledWith({
      q: 'example',
      from: '2026-10-01',
      skip: 0,
      take: 25,
    })
    const results = await screen.findByRole('region', { name: 'Live ledger results' })
    expect(results).toHaveTextContent('30 entries on the test side; showing 1–1.')
    expect(results).toHaveTextContent('audit entry #43')
    expect(within(results).getByText('−$11.31')).toBeInTheDocument()
    expect(within(results).getByText('Domain charge', { exact: false })).toBeInTheDocument()

    await user.click(within(results).getByRole('button', { name: 'Next' }))
    expect(searchLiveLedger).toHaveBeenLastCalledWith({
      q: 'example',
      from: '2026-10-01',
      skip: 25,
      take: 25,
    })
  })

  it('says when DomainNameAPI lists nothing, and shows refusals in words', async () => {
    vi.mocked(searchLiveLedger).mockResolvedValueOnce(
      answer({
        ok: true,
        auditId: 44,
        data: { side: 'test', total: 0, readAt: READ_AT, items: [] },
      }),
    )
    vi.mocked(searchLiveLedger).mockResolvedValueOnce({ serverError: SERVER_CRASH_WORDS } as never)
    const user = userEvent.setup()
    render(<LiveLedgerSearch />)
    await user.click(screen.getByRole('button', { name: 'Search the live ledger' }))
    expect(
      await screen.findByText(/DomainNameAPI lists no entries for this search\./),
    ).toBeInTheDocument()
    expect(searchLiveLedger).toHaveBeenCalledWith({ skip: 0, take: 25 })
    await user.click(screen.getByRole('button', { name: 'Search the live ledger' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't tell whether")
  })
})

describe('DomainLookup', () => {
  async function setup() {
    const user = userEvent.setup()
    render(<DomainLookup renewCheckEnabled />)
    await user.type(screen.getByLabelText('Domain name'), ' Example.com ')
    await user.type(screen.getByLabelText('Why (optional)'), 'Ticket 42')
    return user
  }

  it('reads the registry, a transfer, renewability and verification — each on a press', async () => {
    vi.mocked(lookupDomain).mockResolvedValue(
      answer({
        ok: true,
        auditId: 1,
        data: {
          name: 'example.com',
          outcome: 'ok',
          status: 'Active',
          statusCode: 'ok',
          expiresAt: '2027-09-23T08:44:10Z',
          rgpExpiresAt: null,
          transferLock: true,
          privacy: false,
          nameservers: ['ns1.example.net', 'ns2.example.net'],
          readAt: READ_AT,
        },
      }),
    )
    vi.mocked(readTransferState).mockResolvedValue(
      answer({
        ok: true,
        auditId: 2,
        data: {
          name: 'example.com',
          state: 'rejected',
          supplierStatus: 'rejected',
          requestedAt: null,
          finalAt: null,
          readAt: READ_AT,
        },
      }),
    )
    vi.mocked(checkRenewable).mockResolvedValue(
      answer({
        ok: true,
        auditId: 3,
        data: {
          name: 'example.com',
          renewable: false,
          renewalLock: true,
          reasonKey: 'PERIOD_NOT_ALLOWED',
          readAt: READ_AT,
        },
      }),
    )
    vi.mocked(readRegistrantVerification).mockResolvedValue(
      answer({ ok: true, auditId: 4, data: null }),
    )
    const user = await setup()

    await user.click(screen.getByRole('button', { name: 'Read the registry now' }))
    expect(lookupDomain).toHaveBeenCalledWith({ name: 'Example.com', reason: 'Ticket 42' })
    let status = await screen.findByRole('status')
    expect(status).toHaveTextContent('ns1.example.net, ns2.example.net')
    expect(status).toHaveTextContent('audit entry #1')

    await user.click(screen.getByRole('button', { name: 'Read the transfer state' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Refused by the registry or the losing registrar',
      ),
    )

    await user.selectOptions(screen.getByRole('combobox', { name: 'Years' }), '2')
    await user.click(screen.getByRole('button', { name: 'Check renewability' }))
    expect(checkRenewable).toHaveBeenCalledWith({
      name: 'Example.com',
      years: 2,
      reason: 'Ticket 42',
    })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('period not allowed'))

    await user.click(screen.getByRole('button', { name: 'Registrant verification' }))
    status = await screen.findByText(/lists no registrant for this domain/)
    expect(status).toHaveTextContent('Audit entry #4')
  })

  it('says a domain is not in the account, and shows a refusal in words', async () => {
    vi.mocked(lookupDomain).mockResolvedValueOnce(
      answer({
        ok: true,
        auditId: 5,
        data: {
          name: 'example.com',
          outcome: 'not_found',
          status: null,
          statusCode: null,
          expiresAt: null,
          rgpExpiresAt: null,
          transferLock: null,
          privacy: null,
          nameservers: [],
          readAt: READ_AT,
        },
      }),
    )
    vi.mocked(readRegistrantVerification).mockResolvedValueOnce(
      answer({
        ok: true,
        auditId: 6,
        data: {
          name: 'example.com',
          isVerified: true,
          operationStatus: null,
          verifiedAt: READ_AT,
          fieldType: 'Email',
          readAt: READ_AT,
        },
      }),
    )
    vi.mocked(readTransferState).mockResolvedValueOnce(
      answer({ ok: false, code: 'TOO_SOON', message: 'This was read moments ago.' }),
    )
    const user = await setup()
    await user.click(screen.getByRole('button', { name: 'Read the registry now' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Not in our DomainNameAPI account on this side',
    )
    await user.click(screen.getByRole('button', { name: 'Registrant verification' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Email'))
    await user.click(screen.getByRole('button', { name: 'Read the transfer state' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This was read moments ago.')
  })

  it('asks for a name before sending anything, and offers no renewability check while it is off', async () => {
    const user = userEvent.setup()
    render(<DomainLookup renewCheckEnabled={false} />)
    expect(screen.queryByRole('button', { name: 'Check renewability' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Read the transfer state' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a domain name, such as example.com.')
    expect(readTransferState).not.toHaveBeenCalled()
    // Enter in the field reads the registry, as a form would.
    vi.mocked(lookupDomain).mockResolvedValueOnce(
      answer({ ok: false, code: 'TOO_SOON', message: 'This was read moments ago.' }),
    )
    await user.type(screen.getByLabelText('Domain name'), 'example.com{Enter}')
    expect(lookupDomain).toHaveBeenCalledWith({ name: 'example.com', reason: undefined })
  })

  it('marks itself ready once hydrated, and names none of its fields', () => {
    const { container } = render(<DomainLookup renewCheckEnabled />)
    expect(container.querySelector('[data-ready="true"]')).not.toBeNull()
    expect(container.querySelectorAll('input[name], select[name]')).toHaveLength(0)
  })
})

describe('SslLookup, PriceCheck and RegistryListing', () => {
  it('reads a certificate by its name', async () => {
    vi.mocked(lookupSsl).mockResolvedValueOnce(
      answer({
        ok: true,
        auditId: 7,
        data: {
          name: '*.example.com',
          outcome: 'ok',
          status: 'Active',
          isConfigured: true,
          isIssued: true,
          certificateExpiresAt: '2027-04-01T00:00:00Z',
          subscriptionEndsAt: '2027-10-01T00:00:00Z',
          validUntil: null,
          readAt: READ_AT,
        },
      }),
    )
    vi.mocked(lookupSsl).mockResolvedValueOnce(
      answer({
        ok: true,
        auditId: 8,
        data: {
          name: 'example.org',
          outcome: 'not_found',
          status: null,
          isConfigured: null,
          isIssued: null,
          certificateExpiresAt: null,
          subscriptionEndsAt: null,
          validUntil: null,
          readAt: READ_AT,
        },
      }),
    )
    const user = userEvent.setup()
    render(<SslLookup />)
    await user.type(screen.getByLabelText('Certificate name'), '*.example.com')
    await user.click(screen.getByRole('button', { name: 'Read the certificate' }))
    expect(lookupSsl).toHaveBeenCalledWith({ name: '*.example.com' })
    expect(await screen.findByRole('status')).toHaveTextContent('1 Apr 2027')
    await user.click(screen.getByRole('button', { name: 'Read the certificate' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('No certificate by this name'),
    )
  })

  it('asks for a name or an extension before sending anything', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<SslLookup />)
    await user.click(screen.getByRole('button', { name: 'Read the certificate' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a certificate name')
    unmount()
    render(<PriceCheck />)
    await user.type(screen.getByLabelText('Extension'), '.c{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an extension, such as com.')
    expect(lookupSsl).not.toHaveBeenCalled()
    expect(checkSupplierPrice).not.toHaveBeenCalled()
  })

  it('checks a price against our cost basis', async () => {
    vi.mocked(checkSupplierPrice).mockResolvedValue(
      answer({
        ok: true,
        auditId: 9,
        data: {
          tld: 'com',
          op: 'renew',
          years: 2,
          supplierCents: 2262,
          ourCents: 2200,
          matches: false,
          readAt: READ_AT,
        },
      }),
    )
    const user = userEvent.setup()
    render(<PriceCheck />)
    await user.type(screen.getByLabelText('Extension'), 'com')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Operation' }), 'renew')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Years' }), '2')
    await user.click(screen.getByRole('button', { name: 'Check the price' }))
    expect(checkSupplierPrice).toHaveBeenCalledWith({ tld: 'com', op: 'renew', years: 2 })
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('Renew, 2 years')
    expect(status).toHaveTextContent('$22.62')
    expect(status).toHaveTextContent('Differs')
  })

  it('pages through our account’s domains at the registry', async () => {
    vi.mocked(readRegistryPage).mockResolvedValue(
      answer({
        ok: true,
        auditId: 10,
        data: {
          side: 'live',
          total: 30,
          readAt: READ_AT,
          items: [
            {
              name: 'example.com',
              status: 'Active',
              expiresAt: '2027-09-23T08:44:10Z',
              rgpExpiresAt: null,
              transferLock: true,
              privacy: null,
              renewalModeLabel: 'AutoRenew',
              nameservers: [],
            },
          ],
        },
      }),
    )
    const user = userEvent.setup()
    render(<RegistryListing />)
    await user.click(screen.getByRole('button', { name: 'Read the listing' }))
    expect(readRegistryPage).toHaveBeenCalledWith({ skip: 0, take: 25 })
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('30 domains on the live side; showing 1–1.')
    expect(status).toHaveTextContent('renewal mode "AutoRenew"')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(readRegistryPage).toHaveBeenLastCalledWith({ skip: 25, take: 25 })
  })
})

describe('CataloguePanel', () => {
  it('previews the sync’s changes in its own words', async () => {
    vi.mocked(previewPriceList).mockResolvedValue(
      answer({ ok: true, auditId: 11, data: preview() }),
    )
    const user = userEvent.setup()
    render(<CataloguePanel kind="tlds" mayApply={false} />)
    expect(screen.queryByRole('button', { name: 'Apply price list' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Preview changes' }))
    const shown = await screen.findByRole('region', { name: 'Preview' })
    expect(shown).toHaveTextContent('724 extensions listed · 705 sellable · 3 changes')
    expect(shown).toHaveTextContent('3 changes waiting.')
    expect(within(shown).getByText('Wholesale changes:')).toBeInTheDocument()
    expect(
      within(shown).getByText('.com register $11.31 → $11.48 renew $11.31 → $11.48'),
    ).toBeInTheDocument()
  })

  it('applies with the code, and says what was written', async () => {
    vi.mocked(previewSslList).mockResolvedValue(
      answer({ ok: true, auditId: 12, data: preview({ kind: 'ssl', listed: 35, sellable: 32 }) }),
    )
    vi.mocked(applySslList).mockResolvedValue(
      answer({
        ok: true,
        auditId: 13,
        data: { outcome: 'applied', reason: null, changes: 2, readAt: READ_AT },
      }),
    )
    const user = userEvent.setup()
    render(<CataloguePanel kind="ssl" mayApply />)
    await user.click(screen.getByRole('button', { name: 'Preview changes' }))
    await screen.findByRole('region', { name: 'Preview' })
    await user.click(screen.getByRole('button', { name: 'Apply SSL product list' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Apply the SSL product list now?')
    expect(dialog).toHaveTextContent('35 products listed · 32 sellable · 3 changes')
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    await user.click(within(dialog).getByRole('button', { name: 'Apply SSL product list' }))
    expect(applySslList).toHaveBeenCalledWith({ requestKey: expect.any(String), code: '123456' })
    expect(
      await screen.findByText('Applied 2 changes. Site prices update on the next refresh.'),
    ).toBeInTheDocument()
    expect(applyPriceList).not.toHaveBeenCalled()
  })

  it('shows a preview refused in words', async () => {
    vi.mocked(previewPriceList).mockResolvedValueOnce(
      answer({ ok: false, code: 'ROLE', message: "Your admin role can't do this. Ask the owner." }),
    )
    vi.mocked(previewPriceList).mockRejectedValueOnce(new Error('network'))
    const user = userEvent.setup()
    render(<CataloguePanel kind="tlds" mayApply={false} />)
    await user.click(screen.getByRole('button', { name: 'Preview changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Your admin role can't do this.")
    await user.click(screen.getByRole('button', { name: 'Preview changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't reach")
  })
})

describe('TopupAction (money, owner)', () => {
  it('records the naira paid, showing the credit, the reference and the rate against costing', async () => {
    vi.mocked(recordTopup).mockResolvedValue(answer({ ok: true, auditId: 20 }))
    const user = userEvent.setup()
    render(
      <TopupAction
        mode="record"
        traceId={TRACE}
        usdCents={3600}
        occurredAt="2026-10-01T09:00:00Z"
        costing={1328.1}
      />,
    )
    await user.click(screen.getByText('Record what it cost'))
    const trigger = screen.getByRole('button', { name: 'Record top-up' })
    expect(trigger).toBeDisabled()
    await user.type(screen.getByLabelText('NGN paid'), '58,320')
    await user.type(screen.getByLabelText('Payment reference'), 'GTB-0042')
    expect(trigger).toBeEnabled()
    await user.click(trigger)

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Record what this top-up cost?')
    expect(dialog).toHaveTextContent('Ledger credit$36.00 on 1 Oct 2026')
    expect(dialog).toHaveTextContent('NGN paid₦58,320')
    expect(dialog).toHaveTextContent('ReferenceGTB-0042')
    expect(dialog).toHaveTextContent(
      'Effective rate₦1,620.00/$ against costing ₦1,328.10/$ (22.0% above costing)',
    )
    await user.type(within(dialog).getByLabelText('Reason'), 'Paid by transfer on 1 Oct')
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '654321')
    await user.click(within(dialog).getByRole('button', { name: 'Record top-up' }))
    expect(recordTopup).toHaveBeenCalledWith({
      traceId: TRACE,
      ngnPaidKobo: 5_832_000,
      reference: 'GTB-0042',
      reason: 'Paid by transfer on 1 Oct',
      requestKey: expect.any(String),
      code: '654321',
    })
    expect(await within(dialog).findByText('Top-up cost recorded.')).toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
  })

  it('says what is wrong with the naira or the reference, and corrects a record', async () => {
    vi.mocked(correctTopup).mockResolvedValue(
      answer({ ok: false, code: 'NOT_CURRENT', message: 'That record was already corrected.' }),
    )
    const user = userEvent.setup()
    render(
      <TopupAction
        mode="correct"
        traceId={TRACE}
        topupId={7}
        usdCents={1500}
        occurredAt="2026-10-01T09:00:00Z"
        costing={null}
      />,
    )
    await user.click(screen.getByText('Correct'))
    await user.type(screen.getByLabelText('NGN paid'), '1.234')
    await user.tab()
    expect(screen.getByText(/at most two decimal places/)).toBeInTheDocument()
    await user.clear(screen.getByLabelText('NGN paid'))
    await user.type(screen.getByLabelText('NGN paid'), '24300.5')
    await user.type(screen.getByLabelText('Payment reference'), 'GTB-0043')
    await user.click(screen.getByRole('button', { name: 'Correct top-up' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('The first record stays in history, marked as corrected.')
    expect(dialog).toHaveTextContent('no active costing rate to compare')
    await user.type(within(dialog).getByLabelText('Reason'), 'Bank fee was left out')
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '111111')
    await user.click(within(dialog).getByRole('button', { name: 'Correct top-up' }))
    expect(correctTopup).toHaveBeenCalledWith(
      expect.objectContaining({ topupId: 7, ngnPaidKobo: 2_430_050, reference: 'GTB-0043' }),
    )
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That record was already corrected.',
    )
  })
})
