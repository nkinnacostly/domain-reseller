import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The server action is the network boundary: the revert sees only its result.
vi.mock('../actions/domains', () => ({ requestNameservers: vi.fn(), setAutoRenew: vi.fn() }))

const actions = await import('../actions/domains')
const { NameserverHistory, sourceText } = await import('../components/nameserver-history')
const { RevertNameservers } = await import('../components/revert-nameservers')

const DOMAIN_ID = '00000000-0000-4000-8000-000000000001'
const VERCEL = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']
const DEFAULT = ['ns1.domainnameapi.com', 'ns2.domainnameapi.com']

beforeEach(() => vi.mocked(actions.requestNameservers).mockReset())

describe('NameserverHistory (FR-N5)', () => {
  it('lists each change with before and after, when, and who asked', () => {
    render(
      <NameserverHistory
        entries={[
          {
            before: DEFAULT,
            after: VERCEL,
            changedAt: '2026-09-24T10:05:00Z',
            source: { kind: 'request', by: 'you', requestedAt: '2026-09-24T10:00:00Z' },
          },
          {
            before: null,
            after: DEFAULT,
            changedAt: '2026-09-01T09:00:00Z',
            source: { kind: 'first' },
          },
        ]}
      />,
    )
    const [latest, first] = within(
      screen.getByRole('list', { name: 'Nameserver changes' }),
    ).getAllByRole('listitem')
    expect(latest).toHaveTextContent(
      'From ns1.domainnameapi.com, ns2.domainnameapi.com to ns1.vercel-dns.com, ns2.vercel-dns.com',
    )
    expect(latest).toHaveTextContent(/24 Sept 2026.*Asked for by you on 24 Sept 2026/)
    expect(first).not.toHaveTextContent('From')
    expect(first).toHaveTextContent('The first set on record for this domain')
  })

  it('says what the history will hold before there is any', () => {
    render(<NameserverHistory entries={[]} />)
    expect(screen.getByText(/No changes yet/)).toBeInTheDocument()
  })

  it('names who made a change, as far as the log says', () => {
    const at = '2026-09-24T10:00:00Z'
    expect(sourceText({ kind: 'request', by: 'support', requestedAt: at })).toMatch(
      /^Asked for by our support team on /,
    )
    expect(sourceText({ kind: 'request', by: 'us', requestedAt: at })).toMatch(
      /^Asked for by us on /,
    )
    expect(sourceText({ kind: 'registry' })).toBe(
      'Found at the registry — changed outside this panel',
    )
    expect(sourceText({ kind: 'unknown' })).toBe('Recorded from the registry')
  })
})

describe('RevertNameservers (FR-N5, SEC-2, FR-D4)', () => {
  const renderRevert = (hasTwoFactor = true, waiting = false) =>
    render(
      <RevertNameservers
        domainId={DOMAIN_ID}
        domain="getpaid.com"
        previous={VERCEL}
        waiting={waiting}
        hasTwoFactor={hasTwoFactor}
      />,
    )

  it('says a revert already asked for is on its way, with nothing to click', () => {
    renderRevert(false, true)
    expect(screen.getByText(/has been asked for, and waits to be applied/)).toHaveTextContent(
      'Going back to ns1.vercel-dns.com, ns2.vercel-dns.com',
    )
    expect(screen.queryByRole('button', { name: /Revert/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Turn on two-factor' })).not.toBeInTheDocument()
  })

  it('asks for two-factor first, like any nameserver change', () => {
    renderRevert(false)
    expect(screen.getByRole('link', { name: 'Turn on two-factor' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Revert/ })).not.toBeInTheDocument()
  })

  it('goes back in one click, through the same request as typing the set in', async () => {
    const user = userEvent.setup()
    vi.mocked(actions.requestNameservers).mockResolvedValue({
      data: { ok: true, warnings: [], delivery: 'queued' },
    } as never)
    renderRevert()
    await user.click(
      screen.getByRole('button', { name: 'Revert to ns1.vercel-dns.com, ns2.vercel-dns.com' }),
    )
    expect(actions.requestNameservers).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.vercel-dns.com\nns2.vercel-dns.com',
      presetId: null,
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Sent to the registry. The history shows it once it is applied.',
    )
  })

  it('says what a demo domain does with it, and passes on warnings', async () => {
    const user = userEvent.setup()
    vi.mocked(actions.requestNameservers).mockResolvedValue({
      data: {
        ok: true,
        warnings: ["ns2.vercel-dns.com didn't answer just now."],
        delivery: 'demo',
      },
    } as never)
    renderRevert()
    await user.click(screen.getByRole('button', { name: /^Revert to/ }))
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('This is a demo domain, so nothing is sent to a registry.')
    expect(status).toHaveTextContent("didn't answer just now")
  })

  it('says when it is already the set on file', async () => {
    const user = userEvent.setup()
    vi.mocked(actions.requestNameservers).mockResolvedValue({
      data: { ok: true, warnings: [], delivery: 'queued', unchanged: true },
    } as never)
    renderRevert()
    await user.click(screen.getByRole('button', { name: /^Revert to/ }))
    expect(await screen.findByRole('status')).toHaveTextContent('already the nameservers on file')
  })

  it('catches a host that has since gone away — it is checked, not restored', async () => {
    const user = userEvent.setup()
    vi.mocked(actions.requestNameservers).mockResolvedValue({
      data: {
        error: 'Some nameservers need fixing before we can use them.',
        details: ["ns2.vercel-dns.com doesn't exist — check the spelling."],
      },
    } as never)
    renderRevert()
    await user.click(screen.getByRole('button', { name: /^Revert to/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent("doesn't exist")
  })

  it('offers a code prompt that comes back here when the second factor is stale', async () => {
    const user = userEvent.setup()
    vi.mocked(actions.requestNameservers).mockResolvedValue({
      serverError: "Confirm it's you with the code from your authenticator app to continue.",
    } as never)
    renderRevert()
    await user.click(screen.getByRole('button', { name: /^Revert to/ }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('link', { name: 'Enter a code' })).toHaveAttribute(
      'href',
      `/verify?next=${encodeURIComponent('/app/domains/getpaid.com/nameservers')}`,
    )
  })
})
