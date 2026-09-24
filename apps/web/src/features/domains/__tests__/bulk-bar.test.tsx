import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortfolioDomain } from '../lib/portfolio'
import type { NameserverPreset } from '../queries/domains'

// The server actions are the network boundary: the bar sees only their results.
vi.mock('../actions/bulk', () => ({
  changeNameserversInBulk: vi.fn(),
  labelDomainsInBulk: vi.fn(),
  lockTransfersInBulk: vi.fn(),
  setAutoRenewInBulk: vi.fn(),
  setPrivacyInBulk: vi.fn(),
  unlockTransfersInBulk: vi.fn(),
}))
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const actions = await import('../actions/bulk')
const { Portfolio } = await import('../components/portfolio')

const NOW = new Date('2026-09-24T09:00:00Z')
const ACME = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Acme', color: 'blue' as const }
const BANKS = { id: '00000000-0000-4000-8000-0000000000a2', name: 'Banks', color: 'green' as const }
const VERCEL: NameserverPreset = {
  id: '00000000-0000-4000-8000-0000000000f1',
  provider: 'Vercel',
  nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
  assignsPerZone: false,
  notes: null,
  sourceUrl: 'https://vercel.com/docs',
}
const CLOUDFLARE: NameserverPreset = {
  ...VERCEL,
  id: '00000000-0000-4000-8000-0000000000f2',
  provider: 'Cloudflare',
  nameservers: [],
  assignsPerZone: true,
}

function domain(
  n: number,
  name: string,
  overrides: Partial<PortfolioDomain> = {},
): PortfolioDomain {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    domainName: name,
    tld: name.split('.').slice(1).join('.'),
    source: 'registration',
    testMode: false,
    status: 'active',
    expiresAt: new Date(NOW.getTime() + n * 10 * 86_400_000).toISOString(),
    autoRenew: true,
    privacyEnabled: false,
    transferLock: true,
    delegationStatus: 'verified',
    nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
    pendingNameservers: null,
    labels: [],
    ...overrides,
  }
}

const GETPAID = domain(1, 'getpaid.com', { labels: [ACME] })
const NAIJA = domain(2, 'naija.ng')
const SHOP = domain(3, 'shop.com', { labels: [BANKS] })
const ALL = [GETPAID, NAIJA, SHOP]

function renderPortfolio(overrides: Partial<Parameters<typeof Portfolio>[0]> = {}) {
  return render(
    <Portfolio
      domains={ALL}
      query=""
      within={null}
      labels={[ACME, BANKS]}
      presets={[VERCEL, CLOUDFLARE]}
      hasTwoFactor
      {...overrides}
    />,
  )
}

/** The phone layout's box for a domain — the list, not the table, holds one per domain here. */
const box = (name: string) =>
  within(screen.getByRole('list', { name: 'Your domains' })).getByRole('checkbox', {
    name: `Select ${name}`,
  })
const bar = () => screen.getByRole('region', { name: 'Act on several domains' })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  push.mockReset()
  for (const action of Object.values(actions)) vi.mocked(action).mockReset()
})
afterEach(() => vi.useRealTimers())

describe('selecting domains (FR-P4)', () => {
  it('names each box for its domain, in both layouts', () => {
    renderPortfolio()
    expect(screen.getAllByRole('checkbox', { name: 'Select getpaid.com' })).toHaveLength(2)
    const table = screen.getByRole('table')
    expect(within(table).getByRole('checkbox', { name: 'Select naija.ng' })).toBeInTheDocument()
  })

  it('counts what is ticked, and ticks every shown domain at once', async () => {
    const user = userEvent.setup()
    renderPortfolio()
    expect(within(bar()).getByText('None selected')).toBeInTheDocument()
    await user.click(box('naija.ng'))
    expect(within(bar()).getByText('1 selected')).toBeInTheDocument()

    const all = within(bar()).getByRole('checkbox', { name: 'Select all 3 domains shown' })
    expect(all).not.toBeChecked()
    expect((all as HTMLInputElement).indeterminate).toBe(true)
    await user.click(all)
    expect(within(bar()).getByText('3 selected')).toBeInTheDocument()
    expect(box('getpaid.com')).toBeChecked()
    expect(all).toBeChecked()

    await user.click(within(bar()).getByRole('button', { name: 'Clear' }))
    expect(within(bar()).getByText('None selected')).toBeInTheDocument()
    expect(box('getpaid.com')).not.toBeChecked()
  })

  it('offers the actions only once something is ticked', async () => {
    const user = userEvent.setup()
    renderPortfolio()
    expect(within(bar()).queryByRole('button', { name: 'Nameservers' })).not.toBeInTheDocument()
    await user.click(box('naija.ng'))
    for (const name of ['Auto-renew', 'Nameservers', 'Transfer lock', 'Privacy', 'Labels']) {
      expect(within(bar()).getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false')
    }
  })

  it('selects only within the filter: select all takes what is shown', async () => {
    const user = userEvent.setup()
    renderPortfolio({ labelId: ACME.id })
    await user.click(within(bar()).getByRole('checkbox', { name: 'Select all 1 domain shown' }))
    expect(within(bar()).getByText('1 selected')).toBeInTheDocument()
  })
})

describe('labels on the portfolio (FR-P3)', () => {
  it('shows each domain’s labels, in the cards and the table', () => {
    renderPortfolio()
    const card = within(screen.getByRole('list', { name: 'Your domains' }))
      .getAllByRole('link')
      .find((link) => link.getAttribute('data-domain') === 'getpaid.com')
    expect(card).toHaveTextContent('Labels: Acme')
    const row = within(screen.getByRole('table'))
      .getByRole('rowheader', { name: /^naija\.ng/ })
      .closest('tr')
    expect(row).toHaveTextContent('None')
  })

  it('filters by label, marking the one shown, and keeps the other filters', () => {
    renderPortfolio({ labelId: BANKS.id, query: 'shop', within: 30 })
    const nav = screen.getByRole('navigation', { name: 'Labels' })
    expect(within(nav).getByRole('link', { name: 'Banks' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Acme' })).toHaveAttribute(
      'href',
      `/app/domains?q=shop&within=30&label=${ACME.id}`,
    )
    expect(within(nav).getByRole('link', { name: 'Any label' })).toHaveAttribute(
      'href',
      '/app/domains?q=shop&within=30',
    )
    expect(within(nav).getByRole('link', { name: 'Manage labels' })).toHaveAttribute(
      'href',
      '/app/settings/labels',
    )
    // The expiry view keeps the label too.
    expect(
      within(screen.getByRole('navigation', { name: 'Expiry' })).getByRole('link', { name: 'All' }),
    ).toHaveAttribute('href', `/app/domains?q=shop&label=${BANKS.id}`)
    const form = screen.getByRole('searchbox', { name: 'Search your domains' }).closest('form')
    expect(form?.querySelector('input[name="label"]')).toHaveValue(BANKS.id)
  })

  it('says so when no domain has the label', () => {
    renderPortfolio({ domains: [NAIJA], labelId: ACME.id })
    expect(screen.getByText('No domain has the label “Acme” yet.')).toBeInTheDocument()
  })

  it('offers no label filter to an account without labels', () => {
    renderPortfolio({ labels: [] })
    expect(screen.queryByRole('navigation', { name: 'Labels' })).not.toBeInTheDocument()
  })
})

describe('renew (FR-P4, FR-P5)', () => {
  it('renews the ticked domains in one order', async () => {
    const user = userEvent.setup()
    renderPortfolio()
    await user.click(box('getpaid.com'))
    await user.click(box('shop.com'))
    expect(within(bar()).getByRole('link', { name: 'Renew' })).toHaveAttribute(
      'href',
      `/app/domains/renew?ids=${GETPAID.id},${SHOP.id}`,
    )
  })

  it('offers the expiry view’s whole list in one click, until something is ticked', async () => {
    const user = userEvent.setup()
    renderPortfolio({ within: 90 })
    const renewAll = within(bar()).getByRole('link', { name: 'Renew all 3 domains' })
    expect(renewAll).toHaveAttribute(
      'href',
      `/app/domains/renew?ids=${GETPAID.id},${NAIJA.id},${SHOP.id}`,
    )
    await user.click(box('naija.ng'))
    expect(within(bar()).queryByRole('link', { name: /Renew all/ })).not.toBeInTheDocument()
  })

  it('says how many can be renewed at once past the limit', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 101 }, (_, index) => domain(index + 1, `d${index}.com`))
    renderPortfolio({ domains: many })
    await user.click(within(bar()).getByRole('checkbox', { name: /Select all/ }))
    expect(within(bar()).queryByRole('link', { name: 'Renew' })).not.toBeInTheDocument()
    expect(within(bar()).getByText('Renew up to 100 at a time.')).toBeInTheDocument()
  })
})

describe('export CSV (FR-P4)', () => {
  let saved: { name: string; text: string }[]
  beforeEach(() => {
    saved = []
    let blob: Blob | null = null
    URL.createObjectURL = vi.fn((value: Blob) => {
      blob = value
      return 'blob:csv'
    })
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      const name = this.download
      // Decoded with the BOM kept: text() would drop it.
      void blob
        ?.arrayBuffer()
        .then((bytes) =>
          saved.push({ name, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) }),
        )
    })
  })

  it('exports every domain shown when none is ticked, and the ticked ones when some are', async () => {
    const user = userEvent.setup()
    renderPortfolio()
    await user.click(within(bar()).getByRole('button', { name: 'Export all as CSV' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]?.name).toBe('domains-2026-09-24.csv')
    // A BOM for spreadsheets, a header, and one line per domain.
    expect(saved[0]?.text.startsWith('﻿Domain,Status,Expires')).toBe(true)
    expect(saved[0]?.text.trim().split('\r\n')).toHaveLength(4)

    await user.click(box('shop.com'))
    await user.click(within(bar()).getByRole('button', { name: 'Export 1 as CSV' }))
    await waitFor(() => expect(saved).toHaveLength(2))
    const lines = saved[1]?.text.trim().split('\r\n') ?? []
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(
      /^shop\.com,Active,\d{4}-\d{2}-\d{2},ns1\.vercel-dns\.com ns2\.vercel-dns\.com,Banks,On,On,Off$/,
    )
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv')
  })
})

describe('the actions (FR-P4, FR-N2)', () => {
  async function open(action: string, ...names: string[]) {
    const user = userEvent.setup()
    renderPortfolio()
    for (const name of names) await user.click(box(name))
    await user.click(within(bar()).getByRole('button', { name: action }))
    return user
  }

  it('opens one action at a time, focused, and closes it again', async () => {
    const user = await open('Auto-renew', 'naija.ng')
    const heading = screen.getByRole('heading', { name: 'Auto-renew for 1 domain' })
    expect(heading).toHaveFocus()
    expect(within(bar()).getByRole('button', { name: 'Auto-renew' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('heading', { name: /for 1 domain/ })).not.toBeInTheDocument()
  })

  it('closes the open action when nothing is ticked any more', async () => {
    const user = await open('Privacy', 'naija.ng')
    await user.click(box('naija.ng'))
    expect(screen.queryByRole('form', { name: /Contact privacy/ })).not.toBeInTheDocument()
  })

  it('turns auto-renew off for the ticked domains, then shows each one’s result', async () => {
    vi.mocked(actions.setAutoRenewInBulk).mockResolvedValue({
      data: { ok: true, operationId: 'op-1', warnings: [] },
    } as never)
    const user = await open('Auto-renew', 'naija.ng', 'getpaid.com')
    const form = screen.getByRole('form', { name: 'Auto-renew for the selected domains' })
    expect(form).toHaveTextContent('Automatic renewal isn’t switched on yet')
    await user.click(within(form).getByRole('radio', { name: 'Off' }))
    await user.click(
      within(form).getByRole('button', { name: 'Turn auto-renew off for 2 domains' }),
    )
    expect(actions.setAutoRenewInBulk).toHaveBeenCalledWith({
      domainIds: [GETPAID.id, NAIJA.id],
      enabled: false,
    })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/domains/bulk/op-1'))
  })

  it('says why a change did not start', async () => {
    vi.mocked(actions.setPrivacyInBulk).mockResolvedValue({
      data: { error: 'You have started several bulk changes in the last few minutes.' },
    } as never)
    const user = await open('Privacy', 'naija.ng')
    const form = screen.getByRole('form', { name: 'Contact privacy for the selected domains' })
    expect(form).toHaveTextContent('country extensions such as .ng are skipped')
    await user.click(within(form).getByRole('button', { name: 'Turn privacy on for 1 domain' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('several bulk changes')
    expect(push).not.toHaveBeenCalled()
  })

  it('locks with the lock action, and unlocks with the unlock action', async () => {
    vi.mocked(actions.lockTransfersInBulk).mockResolvedValue({
      data: { ok: true, operationId: 'op-2', warnings: [] },
    } as never)
    vi.mocked(actions.unlockTransfersInBulk).mockResolvedValue({
      serverError: "Confirm it's you with the code from your authenticator app to continue.",
    } as never)
    const user = await open('Transfer lock', 'naija.ng')
    const form = screen.getByRole('form', { name: 'Transfer lock for the selected domains' })
    await user.click(within(form).getByRole('radio', { name: 'Unlocked' }))
    await user.click(within(form).getByRole('button', { name: 'Unlock 1 domain' }))
    expect(actions.unlockTransfersInBulk).toHaveBeenCalledWith({ domainIds: [NAIJA.id] })
    // The step-up comes back to the list, filtered as it was.
    const alert = await within(form).findByRole('alert')
    expect(within(alert).getByRole('link', { name: 'Enter a code' })).toHaveAttribute(
      'href',
      '/verify?next=%2Fapp%2Fdomains',
    )

    await user.click(within(form).getByRole('radio', { name: 'Locked' }))
    await user.click(within(form).getByRole('button', { name: 'Lock 1 domain' }))
    expect(actions.lockTransfersInBulk).toHaveBeenCalledWith({ domainIds: [NAIJA.id] })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/domains/bulk/op-2'))
  })

  it('sends someone without two-factor to turn it on before unlocking or changing nameservers', async () => {
    const user = userEvent.setup()
    renderPortfolio({ hasTwoFactor: false })
    await user.click(box('naija.ng'))
    await user.click(within(bar()).getByRole('button', { name: 'Transfer lock' }))
    await user.click(screen.getByRole('radio', { name: 'Unlocked' }))
    expect(screen.getByRole('link', { name: 'Turn on two-factor' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unlock 1 domain' })).not.toBeInTheDocument()

    await user.click(within(bar()).getByRole('button', { name: 'Nameservers' }))
    expect(screen.getByText(/needs two-factor authentication/)).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: /Nameservers for/ })).not.toBeInTheDocument()
  })

  it('adds or removes one of the account’s labels', async () => {
    vi.mocked(actions.labelDomainsInBulk).mockResolvedValue({
      data: { ok: true, operationId: 'op-3', warnings: [] },
    } as never)
    const user = await open('Labels', 'naija.ng', 'shop.com')
    const form = screen.getByRole('form', { name: 'Labels for the selected domains' })
    await user.selectOptions(within(form).getByLabelText('Label'), 'Banks')
    await user.click(within(form).getByRole('radio', { name: 'Remove a label' }))
    await user.click(within(form).getByRole('button', { name: 'Remove “Banks” from 2 domains' }))
    expect(actions.labelDomainsInBulk).toHaveBeenCalledWith({
      domainIds: [NAIJA.id, SHOP.id],
      labelId: BANKS.id,
      on: false,
    })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/domains/bulk/op-3'))
  })

  it('points an account without labels to where they are made', async () => {
    const user = userEvent.setup()
    renderPortfolio({ labels: [] })
    await user.click(box('naija.ng'))
    await user.click(within(bar()).getByRole('button', { name: 'Labels' }))
    expect(screen.getByRole('link', { name: 'Create a label' })).toHaveAttribute(
      'href',
      '/app/settings/labels',
    )
  })

  it('fills the nameservers from a verified preset, and lists what needs fixing', async () => {
    vi.mocked(actions.changeNameserversInBulk).mockResolvedValue({
      data: {
        error: 'Some nameservers need fixing before we can use them.',
        details: ["ns2.vercel-dns.com doesn't exist — check the spelling."],
      },
    } as never)
    const user = await open('Nameservers', 'naija.ng', 'getpaid.com')
    const form = screen.getByRole('form', { name: 'Nameservers for the selected domains' })
    // N11: only the presets the page was given — the visible ones.
    await user.selectOptions(within(form).getByLabelText('Where are these sites hosted?'), 'Vercel')
    expect(within(form).getByLabelText('Nameservers')).toHaveValue(
      'ns1.vercel-dns.com\nns2.vercel-dns.com',
    )
    // FR-N6 — what switching does to what is served now.
    expect(form).toHaveTextContent('stop working unless the new host has them too')
    await user.click(
      within(form).getByRole('button', { name: 'Point 2 domains at these nameservers' }),
    )
    expect(actions.changeNameserversInBulk).toHaveBeenCalledWith({
      domainIds: [GETPAID.id, NAIJA.id],
      nameservers: 'ns1.vercel-dns.com\nns2.vercel-dns.com',
      presetId: VERCEL.id,
    })
    const alert = await within(form).findByRole('alert')
    expect(alert).toHaveTextContent("ns2.vercel-dns.com doesn't exist")
  })

  it('explains a per-zone host, which one set cannot fit', async () => {
    const user = await open('Nameservers', 'naija.ng')
    const form = screen.getByRole('form', { name: 'Nameservers for the selected domains' })
    await user.selectOptions(
      within(form).getByLabelText('Where are these sites hosted?'),
      'Cloudflare',
    )
    expect(form).toHaveTextContent('Cloudflare gives each domain its own nameservers')
    expect(within(form).getByLabelText('Nameservers')).toHaveValue('')
  })

  it('shows warnings before moving on, with a link to the results', async () => {
    vi.mocked(actions.changeNameserversInBulk).mockResolvedValue({
      data: {
        ok: true,
        operationId: 'op-4',
        warnings: ["ns2.example.com didn't answer just now."],
      },
    } as never)
    const user = await open('Nameservers', 'naija.ng')
    const form = screen.getByRole('form', { name: 'Nameservers for the selected domains' })
    await user.type(within(form).getByLabelText('Nameservers'), 'ns1.example.com\nns2.example.com')
    await user.click(within(form).getByRole('button', { name: /^Point 1 domain/ }))
    expect(await screen.findByText("ns2.example.com didn't answer just now.")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See each domain’s result' })).toHaveAttribute(
      'href',
      '/app/domains/bulk/op-4',
    )
    expect(push).not.toHaveBeenCalled()
  })

  it('says so when a change could not be sent at all', async () => {
    vi.mocked(actions.setPrivacyInBulk).mockResolvedValue({ validationErrors: {} } as never)
    const user = await open('Privacy', 'naija.ng')
    await user.click(screen.getByRole('button', { name: 'Turn privacy on for 1 domain' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not go through.')
  })
})
