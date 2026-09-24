import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NameserverPreset } from '../queries/domains'

// The server action is the network boundary: the form sees only its result.
vi.mock('../actions/domains', () => ({ setAutoRenew: vi.fn(), requestNameservers: vi.fn() }))

const { requestNameservers } = await import('../actions/domains')
const { NameserverForm } = await import('../components/nameserver-form')

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

type Props = Parameters<typeof NameserverForm>[0]

function renderForm(overrides: Partial<Props> = {}) {
  return render(
    <NameserverForm
      domainId={DOMAIN_ID}
      domain="getpaid.com"
      current={['ns1.oldhost.com', 'ns2.oldhost.com']}
      presets={[VERCEL, CLOUDFLARE]}
      hasTwoFactor
      currentRecords={[]}
      {...overrides}
    />,
  )
}

const answer = (result: unknown) => vi.mocked(requestNameservers).mockResolvedValue(result as never)
const form = () => screen.getByRole('form', { name: 'Change nameservers' })
const box = () => screen.getByRole('textbox', { name: 'Nameservers' })
const host = () => screen.getByRole('combobox', { name: 'Where is your site hosted?' })
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

describe('NameserverForm (FR-D1)', () => {
  it('starts from the nameservers on file, one per line', () => {
    renderForm()
    expect(box()).toHaveValue('ns1.oldhost.com\nns2.oldhost.com')
    expect(box()).toHaveAccessibleDescription(
      'Two or more, one per line — exactly as your host gave them.',
    )
    expect(host()).toHaveValue('')
  })

  it('starts empty when none are on file yet', () => {
    renderForm({ current: null })
    expect(box()).toHaveValue('')
  })

  it('fills the box from a host’s preset and links to that host’s own instructions', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.selectOptions(host(), 'Vercel')

    expect(box()).toHaveValue('ns1.vercel-dns.com\nns2.vercel-dns.com')
    expect(screen.getByText(/Add the domain to your Vercel project first\./)).toBeInTheDocument()
    const instructions = screen.getByRole('link', { name: "Vercel's instructions" })
    expect(instructions).toHaveAttribute('href', VERCEL.sourceUrl)
    expect(instructions).toHaveAttribute('target', '_blank')
  })

  it('leaves the box alone for a host that assigns nameservers per site', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.selectOptions(host(), 'Cloudflare')

    expect(box()).toHaveValue('ns1.oldhost.com\nns2.oldhost.com')
    expect(screen.getByText(/Cloudflare gives each site its own pair\./)).toBeInTheDocument()
  })

  it('drops the host’s note when the person goes back to pasting their own', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.selectOptions(host(), 'Vercel')
    await user.selectOptions(host(), "Somewhere else — I'll paste them")

    expect(screen.queryByRole('link', { name: /instructions/ })).not.toBeInTheDocument()
    expect(box()).toHaveValue('ns1.vercel-dns.com\nns2.vercel-dns.com')
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

  it('saves exactly what is in the box, with the preset it came from', async () => {
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

  it('sends no preset for nameservers typed by hand', async () => {
    answer({ data: { ok: true, warnings: [], delivery: 'queued' } })
    const user = userEvent.setup()
    renderForm({ current: null })

    await user.type(box(), 'ns1.myhost.ng{Enter}ns2.myhost.ng')
    await user.click(save())

    expect(requestNameservers).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.myhost.ng\nns2.myhost.ng',
      presetId: null,
    })
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
    renderForm()

    await user.click(save())

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

    settle({ data: { ok: true, warnings: [], delivery: 'queued' } })
    await waitFor(() => expect(save()).toBeEnabled())
    expect(requestNameservers).toHaveBeenCalledTimes(1)
  })
})
