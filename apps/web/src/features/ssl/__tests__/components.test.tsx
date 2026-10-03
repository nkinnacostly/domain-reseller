import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addSslToCart } from '@/features/cart/actions/ssl'
import {
  checkCertificateRequest,
  generateCertificateRequest,
  loadApprovers,
  requestCertificateReissue,
  requestCertificateSetup,
} from '../actions/setup'
import { AddCertificateForm } from '../components/add-certificate-form'
import { CertificateDetail, contactToForm } from '../components/certificate-detail'
import { CertificateList } from '../components/certificate-list'
import { CertificateSetupForm } from '../components/certificate-setup-form'
import { IssuedCertificate } from '../components/issued-certificate'
import { SslOffers } from '../components/ssl-offers'
import { TextFile } from '../components/text-file'

// The server actions are the network boundary for these components.
vi.mock('../actions/setup', () => ({
  loadApprovers: vi.fn(),
  checkCertificateRequest: vi.fn(),
  generateCertificateRequest: vi.fn(),
  requestCertificateSetup: vi.fn(),
  requestCertificateReissue: vi.fn(),
}))
vi.mock('@/features/cart/actions/ssl', () => ({ addSslToCart: vi.fn() }))
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const ID = '6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10'
const NOW = new Date('2026-10-02T12:00:00Z')
const KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEtestONLY\n-----END RSA PRIVATE KEY-----'
const CSR = '-----BEGIN CERTIFICATE REQUEST-----\nMIICtest\n-----END CERTIFICATE REQUEST-----'
const CONTACT = {
  firstName: 'Ada',
  lastName: 'Okafor',
  company: '',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '08031234567',
  addressLine1: '12 Admiralty Way',
  addressLine2: '',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(loadApprovers).mockResolvedValue({
    data: { emails: ['admin@example.com', 'webmaster@example.com'] },
  } as never)
})

function setupForm(over: Partial<Parameters<typeof CertificateSetupForm>[0]> = {}) {
  return render(
    <CertificateSetupForm
      certificateId={ID}
      commonName="example.com"
      isWildcard={false}
      includedNames={1}
      contact={CONTACT}
      problem={null}
      {...over}
    />,
  )
}

describe('setting a certificate up (FR-SSL-4)', () => {
  it('loads who can approve it, checks a pasted CSR, and sends the set-up', async () => {
    const user = userEvent.setup()
    vi.mocked(checkCertificateRequest).mockResolvedValue({
      data: {
        summary: {
          commonName: 'example.com',
          alternativeNames: [],
          isWildcard: false,
          organization: 'Example Ltd',
          country: 'NG',
        },
      },
    } as never)
    vi.mocked(requestCertificateSetup).mockResolvedValue({ data: { ok: true } } as never)
    setupForm()

    const approvers = await screen.findByRole('radiogroup', { name: 'Approval address' })
    expect(within(approvers).getAllByRole('radio')).toHaveLength(2)
    // Pasted, as people do: typing a whole CSR key by key timed out under load.
    await user.click(screen.getByLabelText('Paste the CSR'))
    await user.paste(CSR)
    await user.click(screen.getByRole('button', { name: 'Check it' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'The CA reads this request as being for example.com, Example Ltd.',
    )

    await user.click(within(approvers).getByRole('radio', { name: 'admin@example.com' }))
    await user.selectOptions(screen.getByLabelText('Where it will be installed'), 'iis')
    await user.click(screen.getByRole('button', { name: 'Send to the certificate authority' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(requestCertificateSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        certificateId: ID,
        csr: CSR,
        approverEmail: 'admin@example.com',
        webServer: 'iis',
        extraNames: [],
        contact: expect.objectContaining({ firstName: 'Ada', city: 'Lagos' }),
      }),
    )
  }, 15_000)

  it('shows a generated key once, and sends nothing until it is saved', async () => {
    const user = userEvent.setup()
    vi.mocked(generateCertificateRequest).mockResolvedValue({
      data: { csr: CSR, privateKey: KEY },
    } as never)
    const view = setupForm()
    await user.click(screen.getByRole('radio', { name: /Make one for me/ }))
    expect(screen.getByText(/passes through our server to your browser/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Make my key and CSR' }))
    expect(generateCertificateRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        certificateId: ID,
        organization: 'Ada Okafor',
        locality: 'Lagos',
        country: 'NG',
      }),
    )
    expect(await screen.findByLabelText('Your private key')).toHaveValue(KEY)
    expect(screen.getByText(/It is shown\s+once/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Send to the certificate authority' }))
    expect(requestCertificateSetup).not.toHaveBeenCalled()
    expect(screen.getByText('Tick that you have saved the key first.')).toBeInTheDocument()

    // Gone with the page: nothing of the key survives unmounting (N13).
    view.unmount()
    expect(document.body.textContent).not.toContain('PRIVATE KEY')
  })

  it('asks for the other names on a multi-domain certificate', async () => {
    const user = userEvent.setup()
    vi.mocked(requestCertificateSetup).mockResolvedValue({
      data: { error: 'notexample.com is not under example.com', field: 'extraNames' },
    } as never)
    setupForm({ includedNames: 4 })
    await user.type(
      screen.getByLabelText('Up to 3 more names, one per line'),
      'www.example.com\nnotexample.com',
    )
    await user.type(screen.getByLabelText('Paste the CSR'), CSR)
    await user.click(await screen.findByRole('radio', { name: 'admin@example.com' }))
    await user.click(screen.getByRole('button', { name: 'Send to the certificate authority' }))
    expect(requestCertificateSetup).toHaveBeenCalledWith(
      expect.objectContaining({ extraNames: ['www.example.com', 'notexample.com'] }),
    )
    expect(await screen.findByText('notexample.com is not under example.com')).toBeInTheDocument()
  })

  it('shows a refused earlier set-up, and an approver list it could not load, with a retry', async () => {
    const user = userEvent.setup()
    vi.mocked(loadApprovers).mockResolvedValueOnce({
      data: { error: 'We could not reach the certificate supplier just now.' },
    } as never)
    setupForm({ problem: 'The certificate request (CSR) is for a different name.' })
    expect(screen.getByText(/The last set-up was not accepted/)).toBeInTheDocument()
    expect(
      await screen.findByText('We could not reach the certificate supplier just now.'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('radio', { name: 'webmaster@example.com' })).toBeInTheDocument()
  })

  it('shows a contact field the supplier would refuse beside the field', async () => {
    const user = userEvent.setup()
    vi.mocked(requestCertificateSetup).mockResolvedValue({
      data: { error: 'Use 20 characters or fewer', field: 'contact.city' },
    } as never)
    setupForm()
    await user.type(screen.getByLabelText('Paste the CSR'), CSR)
    await user.click(await screen.findByRole('radio', { name: 'admin@example.com' }))
    await user.click(screen.getByRole('button', { name: 'Send to the certificate authority' }))
    expect(await screen.findByText('Use 20 characters or fewer')).toBeInTheDocument()
  })
})

describe('an issued certificate (FR-SSL-7, FR-SSL-8)', () => {
  const FILES = [{ name: 'example.com.crt', label: 'Certificate', content: 'PEM-TEXT' }]

  it('offers each file to copy or download, and asks before reissuing', async () => {
    const user = userEvent.setup()
    vi.mocked(requestCertificateReissue).mockResolvedValue({ data: { ok: true } } as never)
    render(<IssuedCertificate certificateId={ID} files={FILES} canReissue />)
    expect(screen.getByLabelText('Certificate')).toHaveValue('PEM-TEXT')
    expect(screen.getByRole('button', { name: 'Copy Certificate' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download example.com.crt' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reissue this certificate' }))
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(requestCertificateReissue).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Reissue this certificate' }))
    await user.click(screen.getByRole('button', { name: 'Yes, reissue it' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(requestCertificateReissue).toHaveBeenCalledWith({ certificateId: ID })
  })

  it('says so while the CA has issued it but the supplier has no text yet, and shows a refused reissue', async () => {
    const user = userEvent.setup()
    vi.mocked(requestCertificateReissue).mockResolvedValue({
      data: { error: 'This certificate has moved on.' },
    } as never)
    render(<IssuedCertificate certificateId={ID} files={[]} canReissue />)
    expect(screen.getByText(/Its text is not available from our supplier yet/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reissue this certificate' }))
    await user.click(screen.getByRole('button', { name: 'Yes, reissue it' }))
    expect(await screen.findByText('This certificate has moved on.')).toBeInTheDocument()
  })
})

describe('a text file to copy or download', () => {
  it('copies to the clipboard, downloads a file, and says when the browser will not copy', async () => {
    const user = userEvent.setup()
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const createObjectURL = vi.fn(() => 'blob:x')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<TextFile label="Certificate" fileName="example.com.crt" content="PEM" />)
    await user.click(screen.getByRole('button', { name: 'Copy Certificate' }))
    expect(writeText).toHaveBeenCalledWith('PEM')
    expect(await screen.findByRole('button', { name: 'Copied Certificate' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Download example.com.crt' }))
    expect(createObjectURL).toHaveBeenCalled()
    expect(click).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x')
    await user.click(screen.getByRole('button', { name: /Certificate$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('would not copy it')
    click.mockRestore()
  })
})

describe('the certificate list', () => {
  const ROW = {
    id: ID,
    order_item_id: 'line-1',
    product_code: '351',
    product_name: 'Sectigo PositiveSSL Certificate',
    is_wildcard: false,
    included_names: 1,
    common_name: 'example.com',
    test_mode: true,
    status: 'issued',
    purchased_at: '2026-10-02T11:45:37Z',
    subscription_ends_at: '2027-10-02T11:45:37Z',
    issued_at: '2026-10-02T12:00:00Z',
    expires_at: '2027-04-20T11:54:19Z',
    last_error_code: null,
    created_at: '2026-10-02T11:00:00Z',
  }

  it('lists each certificate with its state and next step', () => {
    render(
      <CertificateList
        now={NOW}
        certificates={[
          ROW,
          {
            ...ROW,
            id: 'b',
            common_name: '*.example.com',
            status: 'awaiting_setup',
            test_mode: false,
          },
          {
            ...ROW,
            id: 'c',
            common_name: 'old.com',
            status: 'issued',
            expires_at: '2026-09-01T00:00:00Z',
          },
          { ...ROW, id: 'd', common_name: 'x.com', status: 'failed' },
          { ...ROW, id: 'e', common_name: 'y.com', status: 'awaiting_validation' },
          { ...ROW, id: 'f', common_name: 'z.com', status: 'pending', expires_at: null },
          { ...ROW, id: 'g', common_name: 'w.com', status: 'issued', expires_at: null },
        ]}
      />,
    )
    const list = screen.getByRole('list', { name: 'Your SSL certificates' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(7)
    expect(list).toHaveTextContent('Expires on 20 Apr 2027 — in 199 days.')
    expect(list).toHaveTextContent('Next: send the request and choose who approves it.')
    expect(list).toHaveTextContent('Expired on 1 Sept 2026.')
    expect(list).toHaveTextContent('what you paid is refunded')
    expect(list).toHaveTextContent('Next: approve the email')
    expect(
      screen.getByRole('link', { name: 'Open the certificate for example.com' }),
    ).toHaveAttribute('href', `/app/ssl/${ID}`)
    expect(screen.getAllByText('Test')).toHaveLength(6)
  })

  it('has an empty state pointing to the SSL page, and an error state', () => {
    const { unmount } = render(<CertificateList certificates={[]} />)
    expect(screen.getByRole('heading', { name: 'No SSL certificates yet' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /See SSL certificates/ })).toHaveAttribute(
      'href',
      '/ssl',
    )
    unmount()
    render(<CertificateList certificates={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent('couldn’t load your certificates')
  })
})

describe('a certificate’s page (FR-SSL-4 – FR-SSL-8)', () => {
  const certificate = (over: Record<string, unknown> = {}) =>
    ({
      id: ID,
      user_id: 'user-1',
      order_item_id: 'line-1',
      product_code: '351',
      product_name: 'Sectigo PositiveSSL Certificate',
      is_wildcard: false,
      included_names: 1,
      common_name: 'example.com',
      test_mode: false,
      status: 'pending',
      supplier_status: null,
      status_unrecognised_since: null,
      supplier_certificate_id: null,
      purchased_at: '2026-10-02T11:45:37Z',
      subscription_ends_at: '2027-10-02T11:45:37Z',
      validation_method: 'email',
      approver_email: 'admin@example.com',
      san_names: [],
      web_server: 'apache',
      csr: null,
      contact: null,
      configured_at: null,
      last_error_code: null,
      issued_at: null,
      expires_at: null,
      certificate_pem: null,
      ca_bundle_pem: null,
      reissue_count: 0,
      last_checked_at: null,
      next_check_at: null,
      created_at: '2026-10-02T11:00:00Z',
      updated_at: '2026-10-02T11:00:00Z',
      ...over,
    }) as never

  const page = (over: Record<string, unknown> = {}) =>
    render(<CertificateDetail certificate={certificate(over)} contact={CONTACT} now={NOW} />)

  it.each([
    ['pending', 'Ordering your certificate.'],
    ['setting_up', 'Sending your set-up.'],
    ['reissuing', 'Asking for a new certificate.'],
  ])('%s: says what is happening, and keeps the page fresh', (status, text) => {
    vi.useFakeTimers()
    page({ status })
    expect(screen.getByRole('status')).toHaveTextContent(text)
    vi.useRealTimers()
  })

  it('awaiting validation: says who Sectigo emails, and what to do if it does not arrive', () => {
    page({ status: 'awaiting_validation', common_name: '*.example.com', is_wildcard: true })
    expect(screen.getByText('admin@example.com')).toBeInTheDocument()
    expect(document.body.textContent).toContain('to confirm you control example.com')
    expect(document.body.textContent).toContain('Check spam')
  })

  it('awaiting set-up: the form, with a refused set-up explained', async () => {
    page({
      status: 'awaiting_setup',
      last_error_code: 'CSR_NAME_MISMATCH',
      contact: { ...CONTACT, phone: '8031234567', city: 'Ikeja' },
    })
    expect(screen.getByRole('form', { name: 'Set up the certificate' })).toBeInTheDocument()
    expect(screen.getByText(/is for a different name/)).toBeInTheDocument()
    expect(screen.getByLabelText('City')).toHaveValue('Ikeja')
    await act(async () => {})
  })

  it('issued: the files, a warning near expiry, and the dates', () => {
    page({
      status: 'issued',
      issued_at: '2026-04-01T00:00:00Z',
      expires_at: '2026-10-20T00:00:00Z',
      certificate_pem: '-----BEGIN CERTIFICATE-----\nMIIF\n-----END CERTIFICATE-----',
      ca_bundle_pem: '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----',
      san_names: [],
    })
    expect(
      screen.getByText(
        'This certificate expires in 17 days. Reissue it below while your subscription lasts.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Certificate and chain in one file')).toBeInTheDocument()
    expect(document.body.textContent).toContain('Issued 1 April 2026 · expires 20 October 2026')
    expect(document.body.textContent).toContain('2 October 2026 to 2 October 2027')
  })

  it('failed: why, and that it is refunded — or that a test moved no money', () => {
    const { unmount } = page({ status: 'failed', last_error_code: 'NAME_HAS_CERTIFICATE' })
    expect(screen.getByRole('alert')).toHaveTextContent('already holds a certificate for this name')
    expect(screen.getByRole('alert')).toHaveTextContent('refunded automatically')
    unmount()
    page({ status: 'failed', test_mode: true })
    expect(screen.getByText(/no money moved/)).toBeInTheDocument()
    expect(screen.getByText(/Test certificate\./)).toBeInTheDocument()
  })

  it('anything else: who to ask; and a wildcard bought without its dates says when', () => {
    page({ status: 'revoked', subscription_ends_at: null, san_names: ['www.example.com'] })
    expect(screen.getByRole('alert')).toHaveTextContent('shows this certificate as revoked')
    expect(document.body.textContent).toContain('1-year subscription, bought 2 October 2026')
    expect(document.body.textContent).toContain('example.com, www.example.com')
  })

  it('turns a stored contact back into the form', () => {
    expect(contactToForm(null)).toBeNull()
    expect(contactToForm({ firstName: 'A' })).toBeNull()
    expect(contactToForm({ firstName: 'A', email: 'a@b.co' })).toMatchObject({
      phoneCountryCode: '234',
      country: 'NG',
    })
  })
})

describe('the storefront offers', () => {
  const OFFER = {
    productCode: '351',
    name: 'Sectigo PositiveSSL Certificate',
    kind: 'single' as const,
    covers: 'One name.',
    nameLabel: 'The name it is for',
    namePlaceholder: 'www.example.com',
    priceKobo: 1_350_000,
    price: '₦13,500',
    term: '1-year subscription',
    renewal: 'It never renews by itself.',
  }

  it('lists each with its price, term and renewal note, or says prices are withheld', () => {
    const { unmount } = render(
      <SslOffers
        offers={[OFFER, { ...OFFER, productCode: '352', kind: 'wildcard', name: 'Wild' }]}
        vatPct={7.5}
      />,
    )
    const list = screen.getByRole('list', { name: 'SSL certificates' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(list).toHaveTextContent('₦13,500')
    expect(list).toHaveTextContent('It never renews by itself.')
    expect(screen.getByText(/before VAT \(7.5%\)/)).toBeInTheDocument()
    unmount()
    render(<SslOffers offers={null} vatPct={null} />)
    expect(screen.getByText('Prices are briefly unavailable')).toBeInTheDocument()
  })

  it('adds a certificate for a name, and says what went wrong', async () => {
    const user = userEvent.setup()
    vi.mocked(addSslToCart)
      .mockResolvedValueOnce({ data: { error: 'Leave out the "*."' } } as never)
      .mockResolvedValueOnce({ data: { count: 1, name: 'shop.example.com' } } as never)
    render(
      <AddCertificateForm
        productCode="351"
        productName="PositiveSSL"
        label="The name it is for"
        placeholder="x"
      />,
    )
    await user.type(screen.getByLabelText('The name it is for'), '*.example.com')
    await user.click(screen.getByRole('button', { name: 'Add to cart' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Leave out the "*."')
    await user.clear(screen.getByLabelText('The name it is for'))
    await user.type(screen.getByLabelText('The name it is for'), 'shop.example.com')
    await user.click(screen.getByRole('button', { name: 'Add to cart' }))
    expect(await screen.findByText(/is in your cart/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Go to your cart/ })).toHaveAttribute('href', '/cart')
    expect(addSslToCart).toHaveBeenLastCalledWith({ productCode: '351', name: 'shop.example.com' })
  })
})
