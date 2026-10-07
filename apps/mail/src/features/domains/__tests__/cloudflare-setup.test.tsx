import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addRecordsWithCloudflareToken, startCloudflareConnect } from '../actions/dns-setup'
import { CloudflareSetup } from '../components/cloudflare-setup'
import { domainRecords } from '../lib/records'

/**
 * "Add to Cloudflare" on the domain page (MAIL-SPEC §5.3): the token way
 * with its three steps, the one-click way when Cloudflare has our template,
 * each record's outcome in words, and nothing to press for a viewer.
 */

vi.mock('../actions/dns-setup', () => ({
  addRecordsWithCloudflareToken: vi.fn(),
  startCloudflareConnect: vi.fn(),
}))

const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const DOMAIN = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'
const TOKEN = 'cf-test-token-not-a-secret-0123456789abcd'
const records = domainRecords({
  name: 'acme.example',
  dkimTokens: ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)],
  mailFromDomain: 'send.acme.example',
  region: 'eu-west-2',
})

function show(props: Partial<Parameters<typeof CloudflareSetup>[0]> = {}) {
  return render(
    <CloudflareSetup
      accountId={ACCOUNT}
      domainId={DOMAIN}
      zone="acme.example"
      oneClick={false}
      canManage
      records={records}
      {...props}
    />,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('the token way', () => {
  it('says the zone is on Cloudflare, links the prefilled token page, and asks for the token', async () => {
    show()
    expect(
      screen.getByRole('heading', { name: 'Add them to Cloudflare for you' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/acme\.example’s DNS is on Cloudflare/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Create a token in Cloudflare/ })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('href')).toContain('https://dash.cloudflare.com/profile/api-tokens?')
    const input = screen.getByLabelText('Cloudflare API token')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(screen.queryByRole('button', { name: 'Add records in Cloudflare' })).toBeNull()
  })

  it('sends the token with the domain, shows each outcome, and clears the field', async () => {
    answer(addRecordsWithCloudflareToken, {
      data: {
        ok: true,
        zone: 'acme.example',
        stopped: null,
        results: [
          { id: 'dkim-1', outcome: 'added', seen: [] },
          { id: 'dkim-2', outcome: 'added', seen: [] },
          { id: 'dkim-3', outcome: 'updated', seen: [] },
          { id: 'mail-from-mx', outcome: 'conflict', seen: ['MX 5 mx.other.example'] },
          { id: 'mail-from-spf', outcome: 'present', seen: [] },
          { id: 'dmarc', outcome: 'kept_yours', seen: ['v=DMARC1; p=reject'] },
        ],
      },
    })
    show()
    const input = screen.getByLabelText('Cloudflare API token')
    await userEvent.type(input, TOKEN)
    await userEvent.click(screen.getByRole('button', { name: 'Add the records' }))
    expect(addRecordsWithCloudflareToken).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      domainId: DOMAIN,
      token: TOKEN,
    })
    const list = await screen.findByRole('list', { name: 'What was done in Cloudflare' })
    expect(screen.getByText(/Done in acme\.example: 3 records added or fixed/)).toBeInTheDocument()
    const items = within(list).getAllByRole('listitem')
    expect(within(items[0] as HTMLElement).getByText('DKIM record 1 of 3')).toBeInTheDocument()
    expect(within(items[0] as HTMLElement).getByText('Added')).toBeInTheDocument()
    expect(within(items[2] as HTMLElement).getByText('Set to DNS only')).toBeInTheDocument()
    expect(within(items[3] as HTMLElement).getByText('Needs you')).toBeInTheDocument()
    expect(within(items[3] as HTMLElement).getByText('MX 5 mx.other.example')).toBeInTheDocument()
    expect(within(items[5] as HTMLElement).getByText('Kept yours')).toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('shows a refusal in place', async () => {
    answer(addRecordsWithCloudflareToken, {
      data: { error: 'Cloudflare did not accept that token.' },
    })
    show()
    await userEvent.type(screen.getByLabelText('Cloudflare API token'), TOKEN)
    await userEvent.click(screen.getByRole('button', { name: 'Add the records' }))
    expect(await screen.findByText('Cloudflare did not accept that token.')).toBeInTheDocument()
  })

  it('a run that stopped part-way says what is left', async () => {
    answer(addRecordsWithCloudflareToken, {
      data: {
        ok: true,
        zone: 'acme.example',
        stopped: 'Cloudflare stopped answering part-way.',
        results: [{ id: 'dkim-1', outcome: 'failed', seen: [] }],
      },
    })
    show()
    await userEvent.type(screen.getByLabelText('Cloudflare API token'), TOKEN)
    await userEvent.click(screen.getByRole('button', { name: 'Add the records' }))
    expect(await screen.findByText('Cloudflare stopped answering part-way.')).toBeInTheDocument()
    expect(screen.getByText('Not added')).toBeInTheDocument()
  })
})

describe('the one-click way', () => {
  it('asks for Cloudflare’s address and keeps the token way one press away', async () => {
    vi.mocked(startCloudflareConnect).mockReturnValue(new Promise(() => {}) as never)
    show({ oneClick: true })
    expect(screen.getByLabelText('Cloudflare API token', { selector: 'input' })).not.toBeVisible()
    const toggle = screen.getByRole('button', { name: 'Use a Cloudflare API token instead' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Cloudflare API token')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Add records in Cloudflare' }))
    expect(startCloudflareConnect).toHaveBeenCalledWith({ accountId: ACCOUNT, domainId: DOMAIN })
    const pending = screen.getByRole('button', { name: 'Opening Cloudflare…' })
    expect(pending).toBeDisabled()
  })

  it('shows a refusal in place', async () => {
    answer(startCloudflareConnect, { data: { error: 'That is ten tries for this domain.' } })
    show({ oneClick: true })
    await userEvent.click(screen.getByRole('button', { name: 'Add records in Cloudflare' }))
    expect(await screen.findByText('That is ten tries for this domain.')).toBeInTheDocument()
  })
})

describe('a viewer', () => {
  it('is told who can, with nothing to press', () => {
    show({ canManage: false, oneClick: true })
    expect(
      screen.getByText(/An owner, admin or developer of this account can add/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByLabelText('Cloudflare API token')).toBeNull()
  })
})
