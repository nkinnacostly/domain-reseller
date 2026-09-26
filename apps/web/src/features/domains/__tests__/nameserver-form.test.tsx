import { createRequire } from 'node:module'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NameserverPreset } from '../queries/domains'

// The server action is the network boundary: the form sees only its result.
vi.mock('../actions/domains', () => ({ setAutoRenew: vi.fn(), requestNameservers: vi.fn() }))

const { requestNameservers } = await import('../actions/domains')
const { NameserverForm } = await import('../components/nameserver-form')

/**
 * axe-core, the engine the e2e suite runs through @axe-core/playwright,
 * required from there so both check markup with the same rules. jsdom has no
 * layout, so colour contrast is left to the e2e suite.
 */
type Axe = {
  run(
    context: Element,
    options: object,
  ): Promise<{ violations: { id: string; nodes: { html: string }[] }[] }>
}
const fromHere = createRequire(import.meta.url)
const axe = createRequire(fromHere.resolve('@axe-core/playwright'))('axe-core') as Axe
const violations = async (container: Element) =>
  (
    await axe.run(container, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
      rules: { 'color-contrast': { enabled: false } },
    })
  ).violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.html}`)

const DOMAIN_ID = '7d7f7a0e-1c61-4c4f-9f7e-0a6a2f9b1a11'
const VERCEL: NameserverPreset = {
  id: '0b5c3f1e-2a44-4d5e-8f60-1b2c3d4e5f60',
  provider: 'Vercel',
  nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
  assignsPerZone: false,
  notes: 'Add the domain to your Vercel project first.',
  sourceUrl: 'https://vercel.com/docs/domains',
}
const CLOUDFLARE: NameserverPreset = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  provider: 'Cloudflare',
  nameservers: [],
  assignsPerZone: true,
  notes: 'Cloudflare gives each site its own pair.',
  sourceUrl: 'https://developers.cloudflare.com/dns/zone-setups/full-setup/',
}
/** The side's registrar default, as migration 35 stores it (read from the table, N11). */
const REGISTRAR_DEFAULT: NameserverPreset = {
  id: '5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c',
  provider: 'Registrar default (live)',
  nameservers: ['ns1.registrar.test', 'ns2.registrar.test'],
  assignsPerZone: false,
  notes: 'Not a host.',
  sourceUrl: 'https://rdap.example/domain/example.com',
}

type Props = Parameters<typeof NameserverForm>[0]

function renderForm(overrides: Partial<Props> = {}) {
  return render(
    <NameserverForm
      domainId={DOMAIN_ID}
      domain="getpaid.com"
      current={['ns1.oldhost.com', 'ns2.oldhost.com']}
      presets={[VERCEL, CLOUDFLARE]}
      registrarDefault={REGISTRAR_DEFAULT}
      hasTwoFactor
      currentRecords={[]}
      {...overrides}
    />,
  )
}

const answer = (result: unknown) => vi.mocked(requestNameservers).mockResolvedValue(result as never)
const form = () => screen.getByRole('form', { name: 'Change nameservers' })
const rowsGroup = () => screen.getByRole('group', { name: 'Nameservers' })
const row = (n: number) => screen.getByRole('textbox', { name: `Nameserver ${n}` })
const rowValues = () =>
  within(rowsGroup())
    .getAllByRole('textbox')
    .map((input) => (input as HTMLInputElement).value)
const remove = (n: number) => screen.getByRole('button', { name: `Remove nameserver ${n}` })
const addRow = () => screen.getByRole('button', { name: 'Add row' })
const host = () => screen.getByRole('combobox', { name: 'Where is your site hosted?' })
const useDefault = () => screen.getByRole('button', { name: 'Use default DNS' })
const save = () => screen.getByRole('button', { name: 'Save nameservers' })

beforeEach(() => vi.mocked(requestNameservers).mockReset())

describe('NameserverForm without two-factor (SEC-2)', () => {
  it('asks for two-factor first instead of showing the form', () => {
    renderForm({ hasTwoFactor: false })
    expect(screen.queryByRole('form', { name: 'Change nameservers' })).not.toBeInTheDocument()
    expect(screen.getByText(/needs two-factor authentication/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Turn on two-factor' })).toHaveAttribute(
      'href',
      '/app/settings#two-factor',
    )
  })
})

describe('NameserverForm rows (FR-D1)', () => {
  it('starts with a row for each nameserver on file, each labelled', () => {
    renderForm({ current: ['ns1.oldhost.com', 'ns2.oldhost.com', 'ns3.oldhost.com'] })
    expect(rowValues()).toEqual(['ns1.oldhost.com', 'ns2.oldhost.com', 'ns3.oldhost.com'])
    expect(row(3)).toHaveValue('ns3.oldhost.com')
    expect(row(1)).toHaveAttribute('placeholder', 'ns.example.com')
    expect(row(1)).toHaveAttribute('spellcheck', 'false')
    expect(row(1)).toHaveAttribute('autocapitalize', 'none')
    expect(rowsGroup()).toHaveAccessibleDescription(
      'Two or more, one per row — exactly as your host gave them.',
    )
    expect(host()).toHaveValue('')
  })

  it('starts with two empty rows when none are on file yet', () => {
    renderForm({ current: null })
    expect(rowValues()).toEqual(['', ''])
  })

  it('adds an empty row and moves the cursor into it', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.click(addRow())

    expect(rowValues()).toEqual(['ns1.oldhost.com', 'ns2.oldhost.com', ''])
    expect(row(3)).toHaveFocus()
    await user.keyboard('ns3.oldhost.com')
    expect(row(3)).toHaveValue('ns3.oldhost.com')
  })

  it('keeps two rows at least: removing is off at two', () => {
    renderForm()
    expect(remove(1)).toBeDisabled()
    expect(remove(2)).toBeDisabled()
  })

  it('removes a row, focusing the one that moves up into its place', async () => {
    const user = userEvent.setup()
    renderForm({ current: ['ns1.a.com', 'ns2.a.com', 'ns3.a.com'] })

    await user.click(remove(2))

    expect(rowValues()).toEqual(['ns1.a.com', 'ns3.a.com'])
    expect(row(2)).toHaveFocus()
    expect(remove(1)).toBeDisabled()
  })

  it('removing the last row moves focus to Add row', async () => {
    const user = userEvent.setup()
    renderForm({ current: ['ns1.a.com', 'ns2.a.com', 'ns3.a.com'] })

    await user.click(remove(3))

    expect(rowValues()).toEqual(['ns1.a.com', 'ns2.a.com'])
    expect(addRow()).toHaveFocus()
  })

  it('stops offering rows at the most a registry accepts (13)', async () => {
    const user = userEvent.setup()
    renderForm({ current: null })

    for (let n = 3; n <= 13; n += 1) await user.click(addRow())

    expect(rowValues()).toHaveLength(13)
    expect(screen.queryByRole('button', { name: 'Add row' })).not.toBeInTheDocument()
    expect(form()).toHaveTextContent("That's the most a registry accepts: 13 nameservers.")

    await user.click(remove(13))
    expect(addRow()).toHaveFocus()
  })

  it('spreads a list pasted from a host’s email over the rows', async () => {
    const user = userEvent.setup()
    renderForm({ current: null })

    await user.click(row(1))
    await user.paste('Nameserver 1: ns1.myhost.ng\nNameserver 2: ns2.myhost.ng\nns3.myhost.ng')

    expect(rowValues()).toEqual(['ns1.myhost.ng', 'ns2.myhost.ng', 'ns3.myhost.ng'])
    expect(row(3)).toHaveFocus()
  })

  it('pastes a single nameserver into the row as it is', async () => {
    const user = userEvent.setup()
    renderForm({ current: null })

    await user.click(row(2))
    await user.paste('ns2.myhost.ng')

    expect(rowValues()).toEqual(['', 'ns2.myhost.ng'])
  })

  it('says how long a change takes to be seen everywhere', () => {
    renderForm()
    expect(form()).toHaveTextContent(
      'Nameserver changes usually take effect within a few hours; some networks keep the old ones for up to 48 hours.',
    )
  })

  it('has no accessibility violations, with the most rows and with the default chosen', async () => {
    const user = userEvent.setup()
    const { container } = renderForm({ currentRecords: ['a website address'] })
    expect(await violations(container)).toEqual([])

    await user.click(useDefault())
    for (let n = 3; n <= 13; n += 1) await user.click(addRow())
    expect(await violations(container)).toEqual([])
  })
})

describe('NameserverForm hosts (FR-D1, FR-D2, FR-D3)', () => {
  it('fills the rows from a host’s preset and links to that host’s own instructions', async () => {
    const user = userEvent.setup()
    renderForm({ current: ['ns1.a.com', 'ns2.a.com', 'ns3.a.com'] })

    await user.selectOptions(host(), 'Vercel')

    expect(rowValues()).toEqual(['ns1.vercel-dns.com', 'ns2.vercel-dns.com'])
    expect(screen.getByText(/Add the domain to your Vercel project first\./)).toBeInTheDocument()
    const instructions = screen.getByRole('link', { name: "Vercel's instructions" })
    expect(instructions).toHaveAttribute('href', VERCEL.sourceUrl)
    expect(instructions).toHaveAttribute('target', '_blank')
  })

  it('leaves the rows alone for a host that assigns nameservers per site', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.selectOptions(host(), 'Cloudflare')

    expect(rowValues()).toEqual(['ns1.oldhost.com', 'ns2.oldhost.com'])
    expect(screen.getByText(/Cloudflare gives each site its own pair\./)).toBeInTheDocument()
  })

  it('drops the host’s note when the person goes back to pasting their own', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.selectOptions(host(), 'Vercel')
    await user.selectOptions(host(), "Somewhere else — I'll paste them")

    expect(screen.queryByRole('link', { name: /instructions/ })).not.toBeInTheDocument()
    expect(rowValues()).toEqual(['ns1.vercel-dns.com', 'ns2.vercel-dns.com'])
  })

  it('never lists the registrar’s default as a host', () => {
    renderForm()
    expect(
      within(host())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(["Somewhere else — I'll paste them", 'Vercel', 'Cloudflare'])
  })
})

describe('NameserverForm “Use default DNS” (migration 35)', () => {
  it('fills the rows with the side’s default and marks it chosen, without saving', async () => {
    const user = userEvent.setup()
    renderForm({ current: ['ns1.a.com', 'ns2.a.com', 'ns3.a.com'] })

    await user.click(useDefault())

    expect(rowValues()).toEqual(['ns1.registrar.test', 'ns2.registrar.test'])
    expect(host()).toHaveValue(REGISTRAR_DEFAULT.id)
    expect(within(host()).getByRole('option', { selected: true })).toHaveTextContent(
      "Nowhere yet — the registrar's default",
    )
    // Not a host: it cannot be picked from the list, and there are no host instructions.
    expect(
      within(host()).getByRole('option', { name: "Nowhere yet — the registrar's default" }),
    ).toBeDisabled()
    expect(screen.queryByRole('link', { name: /instructions/ })).not.toBeInTheDocument()
    expect(form()).toHaveTextContent("These are the registrar's own nameservers")
    expect(requestNameservers).not.toHaveBeenCalled()
  })

  it('saves the default with its preset id, through the usual action', async () => {
    answer({ data: { ok: true, warnings: [], delivery: 'queued' } })
    const user = userEvent.setup()
    renderForm()

    await user.click(useDefault())
    await user.click(save())

    expect(requestNameservers).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.registrar.test\nns2.registrar.test',
      presetId: REGISTRAR_DEFAULT.id,
    })
  })

  it('lets the person pick a host again afterwards', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.click(useDefault())
    await user.selectOptions(host(), 'Vercel')

    expect(rowValues()).toEqual(['ns1.vercel-dns.com', 'ns2.vercel-dns.com'])
    expect(
      within(host()).queryByRole('option', { name: "Nowhere yet — the registrar's default" }),
    ).not.toBeInTheDocument()
  })

  it('is not offered when there is no default for the domain’s side', () => {
    renderForm({ registrarDefault: null })
    expect(screen.queryByRole('button', { name: 'Use default DNS' })).not.toBeInTheDocument()
    expect(save()).toBeInTheDocument()
  })

  it('starts on the default when that is what the domain is on', () => {
    renderForm({ current: REGISTRAR_DEFAULT.nameservers, currentPresetId: REGISTRAR_DEFAULT.id })
    expect(host()).toHaveValue(REGISTRAR_DEFAULT.id)
  })
})

describe('NameserverForm saving (FR-D1, FR-D4)', () => {
  it('saves the rows one per line, with the preset they came from', async () => {
    answer({ data: { ok: true, warnings: [], delivery: 'queued' } })
    const user = userEvent.setup()
    renderForm()

    await user.selectOptions(host(), 'Vercel')
    await user.click(save())

    expect(requestNameservers).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.vercel-dns.com\nns2.vercel-dns.com',
      presetId: VERCEL.id,
    })
  })

  it('sends only the filled rows, and no preset for nameservers typed by hand', async () => {
    answer({ data: { ok: true, warnings: [], delivery: 'queued' } })
    const user = userEvent.setup()
    renderForm({ current: null })

    await user.type(row(1), 'ns1.myhost.ng')
    await user.click(addRow())
    await user.click(addRow())
    await user.type(row(4), ' ns2.myhost.ng ')
    await user.click(save())

    expect(requestNameservers).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.myhost.ng\nns2.myhost.ng',
      presetId: null,
    })
  })

  it('warns which live records would stop working after the switch (FR-N6)', () => {
    renderForm({ currentRecords: ['a website address', 'email (2 MX records)'] })
    expect(form()).toHaveTextContent(
      'Your current DNS provider answers for getpaid.com right now: a website address, email (2 MX records).',
    )
  })

  it('has nothing to warn about when the current provider serves nothing', () => {
    renderForm()
    expect(form()).not.toHaveTextContent('Your current DNS provider')
  })

  it.each([
    ['queued', 'Saved and sent to the registry. Activity shows when it is applied.'],
    ['after_registration', 'Saved. They are applied as soon as the registration completes.'],
    ['demo', 'Saved. This is a demo domain, so nothing is sent to a registry.'],
  ])('says what became of a change that was %s', async (delivery, message) => {
    answer({ data: { ok: true, warnings: [], delivery } })
    const user = userEvent.setup()
    renderForm()

    await user.click(save())

    expect(await within(form()).findByRole('status')).toHaveTextContent(message)
    expect(within(form()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says when nothing needed changing', async () => {
    answer({ data: { ok: true, warnings: [], delivery: 'queued', unchanged: true } })
    const user = userEvent.setup()
    renderForm()

    await user.click(save())

    expect(await within(form()).findByRole('status')).toHaveTextContent(
      'Those are already the nameservers on file — nothing to change.',
    )
  })

  it('passes on warnings about nameservers that did not answer', async () => {
    const warning = 'ns2.busy.com didn’t answer just now. It may be busy.'
    answer({ data: { ok: true, warnings: [warning], delivery: 'queued' } })
    const user = userEvent.setup()
    renderForm()

    await user.click(save())

    const status = await within(form()).findByRole('status')
    expect(within(status).getByRole('listitem')).toHaveTextContent(warning)
  })

  it('lists each nameserver that needs fixing when the change is refused (FR-D4)', async () => {
    answer({
      data: {
        error: 'Some nameservers need fixing before we can use them.',
        details: ['ns1.tpyo.com doesn’t exist — check the spelling.', 'ns2.tpyo.com also'],
      },
    })
    const user = userEvent.setup()
    renderForm()

    await user.click(save())

    const alert = await within(form()).findByRole('alert')
    expect(alert).toHaveTextContent('Some nameservers need fixing before we can use them.')
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['ns1.tpyo.com doesn’t exist — check the spelling.', 'ns2.tpyo.com also'])
  })

  it('shows a refusal with no list when there are no details', async () => {
    answer({ data: { error: 'Enter at least two nameservers.' } })
    const user = userEvent.setup()
    renderForm({ current: null })

    await user.click(save())

    expect(requestNameservers).toHaveBeenCalledWith(expect.objectContaining({ nameservers: '' }))
    const alert = await within(form()).findByRole('alert')
    expect(alert).toHaveTextContent('Enter at least two nameservers.')
    expect(within(alert).queryByRole('list')).not.toBeInTheDocument()
  })

  it('offers to enter a code when the change needs a fresh second factor', async () => {
    answer({ serverError: "Confirm it's you with your authenticator code first." })
    const user = userEvent.setup()
    renderForm()

    await user.click(save())

    const alert = await within(form()).findByRole('alert')
    expect(alert).toHaveTextContent("Confirm it's you with your authenticator code first.")
    expect(within(alert).getByRole('link', { name: 'Enter a code' })).toHaveAttribute(
      'href',
      '/verify?next=%2Fapp%2Fdomains%2Fgetpaid.com%2Fnameservers',
    )
  })

  it('shows any other server failure without a code link', async () => {
    answer({ serverError: 'Something went wrong. Please try again.' })
    const user = userEvent.setup()
    renderForm()

    await user.click(save())

    const alert = await within(form()).findByRole('alert')
    expect(alert).toHaveTextContent('Something went wrong. Please try again.')
    expect(within(alert).queryByRole('link')).not.toBeInTheDocument()
  })

  it('says it is checking, and cannot be sent twice, while the lookups run', async () => {
    let settle: (value: unknown) => void = () => {}
    vi.mocked(requestNameservers).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      }) as never,
    )
    const user = userEvent.setup()
    renderForm()

    await user.click(save())

    const pending = screen.getByRole('button', { name: 'Checking each nameserver…' })
    expect(pending).toBeDisabled()
    expect(pending).toHaveAttribute('aria-busy', 'true')
    expect(useDefault()).toBeDisabled()

    settle({ data: { ok: true, warnings: [], delivery: 'queued' } })
    await waitFor(() => expect(save()).toBeEnabled())
    expect(useDefault()).toBeEnabled()
    expect(requestNameservers).toHaveBeenCalledTimes(1)
  })
})

describe('NameserverForm remembers the host (FR-C10)', () => {
  it('starts on the host picked before, at checkout or here', () => {
    renderForm({ current: VERCEL.nameservers, currentPresetId: VERCEL.id })
    expect(host()).toHaveValue(VERCEL.id)
  })

  it('starts on no host when the one picked is no longer offered', () => {
    renderForm({ currentPresetId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' })
    expect(host()).toHaveValue('')
  })
})
