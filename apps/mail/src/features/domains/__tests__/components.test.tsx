import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addDomain, checkDomain, removeDomain, retryDomain } from '../actions/domains'
import { AddDomainForm } from '../components/add-domain-form'
import { CopyButton } from '../components/copy-button'
import { CheckNowButton, RemoveDomainButton, RetryButton } from '../components/domain-actions'
import { DomainStatusPill } from '../components/domain-status'
import { DomainsList } from '../components/domains-list'
import { HostGuides } from '../components/host-guides'
import { RecordsTable } from '../components/records-table'
import { SandboxSender } from '../components/sandbox-sender'
import { domainRecords } from '../lib/records'
import type { Domain } from '../queries/domains'

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/dashboard/domains',
}))
vi.mock('../actions/domains', () => ({
  addDomain: vi.fn(),
  checkDomain: vi.fn(),
  removeDomain: vi.fn(),
  retryDomain: vi.fn(),
}))

const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const DOMAIN = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'
const TOKENS = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3',
]
const records = domainRecords({
  name: 'acme.example',
  dkimTokens: TOKENS,
  mailFromDomain: 'send.acme.example',
  region: 'eu-west-2',
})

beforeEach(() => vi.clearAllMocks())

describe('the records (§5: copy buttons and a live check)', () => {
  it('each record’s name as editors want it, its value, and a named copy button for each', () => {
    render(<RecordsTable records={records} zone="acme.example" live="checking" />)
    const list = screen.getByRole('list', { name: 'DNS records' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(6)
    const first = items[0] as HTMLElement
    expect(within(first).getByRole('heading', { name: /DKIM record 1 of 3/ })).toBeInTheDocument()
    expect(within(first).getByText(`${TOKENS[0]}._domainkey`)).toBeInTheDocument()
    expect(
      within(first).getByText(`In full: ${TOKENS[0]}._domainkey.acme.example`),
    ).toBeInTheDocument()
    expect(
      within(first).getByRole('button', { name: 'Copy the value of DKIM record 1 of 3' }),
    ).toBeInTheDocument()
    expect(within(items[3] as HTMLElement).getByText('Mail server')).toBeInTheDocument()
    expect(within(items[3] as HTMLElement).getByText('10')).toBeInTheDocument()
    expect(screen.getAllByText('Checking public DNS…')).toHaveLength(6)
  })

  it('what public DNS says of each, in words, and what it has instead', () => {
    render(
      <RecordsTable
        records={records}
        zone="acme.example"
        live={[
          { id: 'dkim-1', state: 'found', seen: [] },
          { id: 'dkim-2', state: 'spreading', seen: [] },
          { id: 'dkim-3', state: 'missing', seen: [] },
          { id: 'mail-from-mx', state: 'unknown', seen: [] },
          { id: 'mail-from-spf', state: 'different', seen: ['v=spf1 -all'] },
        ]}
      />,
    )
    expect(screen.getByText('Found')).toBeInTheDocument()
    expect(screen.getByText('Spreading')).toBeInTheDocument()
    expect(screen.getByText('Not found yet')).toBeInTheDocument()
    expect(screen.getByText('Could not check')).toBeInTheDocument()
    expect(screen.getByText('Different value')).toBeInTheDocument()
    expect(screen.getByText('v=spf1 -all')).toBeInTheDocument()
  })

  it('a check that failed says so on every record', () => {
    render(<RecordsTable records={records.slice(0, 1)} zone="acme.example" live="failed" />)
    expect(screen.getByText('Could not check')).toBeInTheDocument()
  })

  it('copies, says so, and says what to do when the browser will not', async () => {
    const user = userEvent.setup()
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('no'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<CopyButton value="abc._domainkey" label="Copy the name" />)
    await user.click(screen.getByRole('button', { name: 'Copy the name' }))
    expect(writeText).toHaveBeenCalledWith('abc._domainkey')
    expect(await screen.findByText('Copied')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy the name' }))
    expect(await screen.findByText('Select the text and copy it')).toBeInTheDocument()
  })
})

describe('adding a domain', () => {
  it('sends the name and opens the domain’s page', async () => {
    const user = userEvent.setup()
    answer(addDomain, { data: { ok: true, domainId: DOMAIN } })
    render(<AddDomainForm accountId={ACCOUNT} />)
    const form = screen.getByRole('form', { name: 'Add a domain' })
    await user.type(within(form).getByLabelText('Domain'), 'acme.example')
    await user.click(within(form).getByRole('button', { name: 'Add domain' }))
    expect(addDomain).toHaveBeenCalledWith({ accountId: ACCOUNT, name: 'acme.example' })
    expect(router.push).toHaveBeenCalledWith(`/dashboard/domains/${DOMAIN}`)
  })

  it('shows SQL’s refusal in words', async () => {
    const user = userEvent.setup()
    answer(addDomain, {
      data: { error: 'This domain is in use on another account.', code: 'in_use' },
    })
    render(<AddDomainForm accountId={ACCOUNT} />)
    await user.type(screen.getByLabelText('Domain'), 'acme.example')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(await screen.findByText('This domain is in use on another account.')).toBeInTheDocument()
    expect(router.push).not.toHaveBeenCalled()
  })
})

describe('a domain’s actions', () => {
  it('"Check now" says what it found', async () => {
    const user = userEvent.setup()
    answer(checkDomain, { data: { ok: true, outcome: 'verified' } })
    render(<CheckNowButton accountId={ACCOUNT} domainId={DOMAIN} />)
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(checkDomain).toHaveBeenCalledWith({ accountId: ACCOUNT, domainId: DOMAIN })
    expect(await screen.findByText(/Amazon SES has verified this domain/)).toBeInTheDocument()
  })

  it('"Check now" when a run is already at it, or something odd', async () => {
    const user = userEvent.setup()
    answer(checkDomain, { data: { ok: true, outcome: 'busy' } })
    const { unmount } = render(<CheckNowButton accountId={ACCOUNT} domainId={DOMAIN} />)
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText(/A check ran a moment ago/)).toBeInTheDocument()
    unmount()
    answer(checkDomain, { data: { ok: true, outcome: 'released' } })
    render(<CheckNowButton accountId={ACCOUNT} domainId={DOMAIN} />)
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Checked.')).toBeInTheDocument()
  })

  it('"Try again", and its refusal', async () => {
    const user = userEvent.setup()
    answer(retryDomain, { data: { error: 'This domain is being released.', code: 'releasing' } })
    render(<RetryButton accountId={ACCOUNT} domainId={DOMAIN} />)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('This domain is being released.')).toBeInTheDocument()
  })

  it('removing asks first, says what it means, and goes back to the list', async () => {
    const user = userEvent.setup()
    answer(removeDomain, { data: { ok: true } })
    render(<RemoveDomainButton accountId={ACCOUNT} domainId={DOMAIN} name="acme.example" />)
    await user.click(screen.getByRole('button', { name: 'Remove domain' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/API keys limited to it stop working/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Remove domain' }))
    expect(removeDomain).toHaveBeenCalledWith({ accountId: ACCOUNT, domainId: DOMAIN })
    expect(router.push).toHaveBeenCalledWith('/dashboard/domains')
  })

  it('a removal refused while emails wait stays open with the reason', async () => {
    const user = userEvent.setup()
    answer(removeDomain, { data: { error: 'One email is still waiting.', code: 'emails_queued' } })
    render(<RemoveDomainButton accountId={ACCOUNT} domainId={DOMAIN} name="acme.example" />)
    await user.click(screen.getByRole('button', { name: 'Remove domain' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Remove domain' }))
    expect(await within(dialog).findByText('One email is still waiting.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(router.push).not.toHaveBeenCalled()
  })
})

describe('the list, the pill, the sandbox sender and the host guides', () => {
  const domain: Domain = {
    id: DOMAIN,
    name: 'acme.example',
    unicode: null,
    kind: 'customer',
    status: 'pending',
    settingUp: false,
    dkimTokens: TOKENS,
    dkimStatus: 'PENDING',
    mailFromDomain: 'send.acme.example',
    mailFromStatus: null,
    failedReason: null,
    missingRecord: null,
    deadline: '2026-10-09T09:30:00Z',
    createdAt: '2026-10-06T09:30:00Z',
    verifiedAt: null,
    lastCheckedAt: null,
    released: false,
  }

  it('each domain with its state in words, linking to its page', () => {
    render(
      <DomainsList
        domains={[
          domain,
          {
            ...domain,
            id: 'v',
            name: 'xn--caf-dma.example',
            unicode: 'café.example',
            status: 'verified',
            verifiedAt: '2026-10-06T10:00:00Z',
          },
          { ...domain, id: 'f', name: 'old.example', status: 'failed' },
          { ...domain, id: 'r', name: 'gone.example', status: 'removing' },
        ]}
      />,
    )
    expect(screen.getByRole('link', { name: /acme\.example.*To verify by/ })).toHaveAttribute(
      'href',
      `/dashboard/domains/${DOMAIN}`,
    )
    expect(screen.getByText('Waiting for DNS')).toBeInTheDocument()
    expect(screen.getByText('café.example')).toBeInTheDocument()
    expect(screen.getByText('Verified')).toBeInTheDocument()
    expect(screen.getByText('Not verified in time')).toBeInTheDocument()
    expect(screen.getByText('Removing')).toBeInTheDocument()
  })

  it('setting up is said; a removed or sandbox row has no pill', () => {
    const { container } = render(
      <>
        <DomainStatusPill status="pending" settingUp />
        <DomainStatusPill status="removed" settingUp={false} />
      </>,
    )
    expect(screen.getByText('Setting up')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-tone]')).toHaveLength(1)
  })

  it('the sandbox sender, as ready', () => {
    render(<SandboxSender fromAddress="onboarding@sandbox.emails.mydomainshub.com" />)
    expect(screen.getByRole('heading', { name: 'Sandbox sending address' })).toBeInTheDocument()
    expect(screen.getByText(/members’ confirmed email addresses/)).toBeInTheDocument()
  })

  it('each host’s steps, with its pages named and opening in a new tab', () => {
    render(<HostGuides />)
    expect(screen.getByText('Cloudflare')).toBeInTheDocument()
    expect(screen.getByText(/“DNS only”/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Proxy status/ })
    expect(link).toHaveAttribute('href', 'https://developers.cloudflare.com/dns/proxy-status/')
    expect(link).toHaveAttribute('target', '_blank')
  })
})
