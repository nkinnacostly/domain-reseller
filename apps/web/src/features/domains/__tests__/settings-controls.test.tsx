import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Activity } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The server actions are the network boundary: the controls see only their results.
vi.mock('../actions/settings', () => ({
  lockTransfers: vi.fn(),
  unlockTransfers: vi.fn(),
  setPrivacy: vi.fn(),
  changeRegistrant: vi.fn(),
  revealTransferCode: vi.fn(),
}))

const actions = await import('../actions/settings')
const { TransferLockControl } = await import('../components/transfer-lock-control')
const { PrivacyControl } = await import('../components/privacy-control')
const { TransferCode } = await import('../components/transfer-code')
const { RegistrantForm } = await import('../components/registrant-form')
const { RegistrantSummary } = await import('../components/registrant-summary')

const DOMAIN_ID = '7d7f7a0e-1c61-4c4f-9f7e-0a6a2f9b1a11'
const CODE = 'Zx9!secret-code'
const ADA = {
  firstName: 'Ada',
  lastName: 'Okafor',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '1 Marina',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}

const answer = (action: (...args: never[]) => unknown, result: unknown) =>
  vi.mocked(action).mockResolvedValue(result as never)

beforeEach(() => {
  for (const action of Object.values(actions)) vi.mocked(action).mockReset()
})

describe('TransferLockControl (FR-DS4, SEC-2)', () => {
  const lock = () => screen.getByRole('switch', { name: 'Transfer lock' })
  function renderLock(over: Partial<Parameters<typeof TransferLockControl>[0]> = {}) {
    return render(
      <TransferLockControl
        domainId={DOMAIN_ID}
        domain="getpaid.com"
        locked
        pending={null}
        editable
        hasTwoFactor
        {...over}
      />,
    )
  }

  it('shows what the registry holds', () => {
    renderLock()
    expect(lock()).toBeChecked()
    expect(lock()).toHaveAccessibleDescription(
      'On — nobody can move this domain to another registrar.',
    )
  })

  it('asks before turning it off, and turns nothing off on “Keep it on”', async () => {
    const user = userEvent.setup()
    renderLock()
    await user.click(lock())
    expect(screen.getByRole('group', { name: 'Turn off the transfer lock?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep it on' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Keep it on' }))
    expect(actions.unlockTransfers).not.toHaveBeenCalled()
    expect(lock()).toBeChecked()
  })

  it('turns it off once confirmed, and says it went to the registry', async () => {
    answer(actions.unlockTransfers, { data: { ok: true } })
    const user = userEvent.setup()
    const { rerender } = renderLock()
    await user.click(lock())
    await user.click(screen.getByRole('button', { name: 'Turn off transfer lock' }))
    expect(actions.unlockTransfers).toHaveBeenCalledWith({ domainId: DOMAIN_ID })
    // The page comes back with the request waiting.
    rerender(
      <TransferLockControl
        domainId={DOMAIN_ID}
        domain="getpaid.com"
        locked
        pending={false}
        editable
        hasTwoFactor
      />,
    )
    await waitFor(() => expect(lock()).not.toBeChecked())
    expect(lock()).toHaveAccessibleDescription('Turning off — waiting for the registry')
    expect(screen.getByRole('status')).toHaveTextContent('Sent to the registry.')
  })

  it('offers a code prompt when the second factor is not fresh', async () => {
    answer(actions.unlockTransfers, {
      serverError: "Confirm it's you with the code from your authenticator app to continue.",
    })
    const user = userEvent.setup()
    renderLock()
    await user.click(lock())
    await user.click(screen.getByRole('button', { name: 'Turn off transfer lock' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('link', { name: 'Enter a code' })).toHaveAttribute(
      'href',
      `/verify?next=${encodeURIComponent('/app/domains/getpaid.com/security')}`,
    )
    expect(lock()).toBeChecked()
  })

  it('turns it on straight away, with no warning', async () => {
    answer(actions.lockTransfers, { data: { error: 'That change could not be saved.' } })
    const user = userEvent.setup()
    renderLock({ locked: false })
    await user.click(lock())
    expect(actions.lockTransfers).toHaveBeenCalledWith({ domainId: DOMAIN_ID })
    expect(await screen.findByRole('alert')).toHaveTextContent('That change could not be saved.')
    expect(lock()).not.toBeChecked()
  })

  it('reports a failure it could not reach the server for', async () => {
    vi.mocked(actions.lockTransfers).mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    renderLock({ locked: false })
    await user.click(lock())
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('needs two-factor on the account before it can be turned off', () => {
    renderLock({ hasTwoFactor: false })
    expect(lock()).toBeDisabled()
    expect(screen.getByRole('link', { name: 'Turn on two-factor' })).toHaveAttribute(
      'href',
      '/app/settings#two-factor',
    )
  })

  it('is switched off for a domain that cannot change', () => {
    renderLock({ editable: false, hasTwoFactor: false })
    expect(lock()).toBeDisabled()
    expect(screen.queryByRole('link', { name: 'Turn on two-factor' })).not.toBeInTheDocument()
  })

  it('says when the lock is off', () => {
    renderLock({ locked: false })
    expect(lock()).toHaveAccessibleDescription(
      'Off — this domain can be moved to another registrar with its transfer code.',
    )
  })
})

describe('PrivacyControl (FR-DS3)', () => {
  const privacy = () => screen.getByRole('switch', { name: 'Contact privacy' })
  function renderPrivacy(over: Partial<Parameters<typeof PrivacyControl>[0]> = {}) {
    return render(
      <PrivacyControl
        domainId={DOMAIN_ID}
        domain="getpaid.com"
        tld="com"
        enabled={false}
        pending={null}
        editable
        offered
        {...over}
      />,
    )
  }

  it('turns it on through the registry', async () => {
    answer(actions.setPrivacy, { data: { ok: true } })
    const user = userEvent.setup()
    renderPrivacy()
    expect(privacy()).toHaveAccessibleDescription(
      'Off — your details can appear in public lookups (RDAP, formerly WHOIS).',
    )
    await user.click(privacy())
    expect(actions.setPrivacy).toHaveBeenCalledWith({ domainId: DOMAIN_ID, enabled: true })
  })

  it('shows a change on its way', () => {
    renderPrivacy({ pending: true })
    expect(privacy()).toBeChecked()
    expect(privacy()).toHaveAccessibleDescription('Turning on — waiting for the registry')
  })

  it('says when it is on', () => {
    renderPrivacy({ enabled: true })
    expect(privacy()).toHaveAccessibleDescription(
      'On — your name, email and phone are kept out of public lookups.',
    )
  })

  it('explains why a country-code extension has none, rather than hiding it', () => {
    renderPrivacy({ tld: 'ng', offered: false })
    expect(privacy()).toBeDisabled()
    expect(privacy()).toHaveAccessibleDescription(/Not offered for \.ng domains/)
  })

  it('shows the refusal', async () => {
    answer(actions.setPrivacy, { data: { error: 'Contact privacy is not offered.' } })
    const user = userEvent.setup()
    renderPrivacy()
    await user.click(privacy())
    expect(await screen.findByRole('alert')).toHaveTextContent('Contact privacy is not offered.')
  })
})

describe('TransferCode (FR-DS5, N14)', () => {
  function renderCode(over: Partial<Parameters<typeof TransferCode>[0]> = {}) {
    return render(
      <TransferCode
        domainId={DOMAIN_ID}
        domain="getpaid.com"
        unavailable={null}
        hasTwoFactor
        testMode={false}
        {...over}
      />,
    )
  }

  it('shows the code once, with a way to copy it, and forgets it when hidden', async () => {
    answer(actions.revealTransferCode, { data: { ok: true, code: CODE } })
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderCode()
    await user.click(screen.getByRole('button', { name: 'Get transfer code' }))
    expect(actions.revealTransferCode).toHaveBeenCalledWith({ domainId: DOMAIN_ID })
    expect(await screen.findByText(CODE)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(writeText).toHaveBeenCalledWith(CODE)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Hide the code' }))
    expect(screen.queryByText(CODE)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Get transfer code' })).toBeInTheDocument()
  })

  it('forgets the code when the page is left, though the router keeps the page (SEC-12)', async () => {
    answer(actions.revealTransferCode, { data: { ok: true, code: CODE } })
    const user = userEvent.setup()
    const page = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <TransferCode
          domainId={DOMAIN_ID}
          domain="getpaid.com"
          unavailable={null}
          hasTwoFactor
          testMode={false}
        />
      </Activity>
    )
    const { rerender } = render(page('visible'))
    await user.click(screen.getByRole('button', { name: 'Get transfer code' }))
    expect(await screen.findByText(CODE)).toBeInTheDocument()
    rerender(page('hidden'))
    rerender(page('visible'))
    await waitFor(() => expect(screen.queryByText(CODE)).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Get transfer code' })).toBeInTheDocument()
  })

  it('says a sandbox code moves no real domain', async () => {
    answer(actions.revealTransferCode, { data: { ok: true, code: CODE } })
    const user = userEvent.setup()
    renderCode({ testMode: true })
    await user.click(screen.getByRole('button', { name: 'Get transfer code' }))
    expect(await screen.findByRole('status')).toHaveTextContent('moves no real domain')
  })

  it('keeps the code on screen when the clipboard refuses', async () => {
    answer(actions.revealTransferCode, { data: { ok: true, code: CODE } })
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    })
    renderCode()
    await user.click(screen.getByRole('button', { name: 'Get transfer code' }))
    await user.click(await screen.findByRole('button', { name: 'Copy code' }))
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
    expect(screen.getByText(CODE)).toBeInTheDocument()
  })

  it('explains a failure, with a step-up link when a code is needed', async () => {
    answer(actions.revealTransferCode, {
      serverError: "Confirm it's you with the code from your authenticator app to continue.",
    })
    const user = userEvent.setup()
    renderCode()
    await user.click(screen.getByRole('button', { name: 'Get transfer code' }))
    expect(await screen.findByRole('link', { name: 'Enter a code' })).toBeInTheDocument()
  })

  it('says why there is no code', () => {
    renderCode({ unavailable: 'This is a demo domain.' })
    expect(screen.getByText('This is a demo domain.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Get transfer code' })).not.toBeInTheDocument()
  })

  it('needs two-factor on the account first', () => {
    renderCode({ hasTwoFactor: false })
    expect(screen.getByRole('link', { name: 'Turn on two-factor' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Get transfer code' })).not.toBeInTheDocument()
  })
})

describe('RegistrantForm (FR-DS1, FR-DS2)', () => {
  function renderForm(over: Partial<Parameters<typeof RegistrantForm>[0]> = {}) {
    return render(
      <RegistrantForm
        domainId={DOMAIN_ID}
        domain="getpaid.com"
        current={ADA}
        requested={null}
        generic
        {...over}
      />,
    )
  }
  const lockBox = () =>
    screen.queryByRole('checkbox', {
      name: 'I understand this domain may not move to another registrar for 60 days.',
    })

  it('starts from the registrant the registry holds', () => {
    renderForm()
    expect(screen.getByRole('textbox', { name: 'First name' })).toHaveValue('Ada')
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('NG')
    expect(lockBox()).not.toBeInTheDocument()
  })

  it('starts from a change still on its way', () => {
    renderForm({ requested: { ...ADA, city: 'Abuja' } })
    expect(screen.getByRole('textbox', { name: 'City' })).toHaveValue('Abuja')
  })

  it('starts empty when nothing is recorded', () => {
    renderForm({ current: null })
    expect(screen.getByRole('textbox', { name: 'First name' })).toHaveValue('')
  })

  it('warns that a new name can lock transfers for 60 days, and sends the choice', async () => {
    answer(actions.changeRegistrant, { data: { ok: true } })
    const user = userEvent.setup()
    renderForm()
    const last = screen.getByRole('textbox', { name: 'Last name' })
    await user.clear(last)
    await user.type(last, 'Obi')
    expect(screen.getByText('This is a change of registrant')).toBeInTheDocument()
    await user.click(lockBox() as HTMLElement)
    await user.click(screen.getByRole('button', { name: 'Save registrant' }))
    expect(actions.changeRegistrant).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      registrant: expect.objectContaining({ lastName: 'Obi', email: 'ada@example.com' }),
      acceptTransferLock: true,
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Saved and sent to the registry.')
  })

  it('asks nothing extra for a new address', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByRole('textbox', { name: 'Street address' }), ', Suite 4')
    expect(lockBox()).not.toBeInTheDocument()
  })

  it('never warns on a country-code extension', async () => {
    const user = userEvent.setup()
    renderForm({ generic: false })
    await user.type(screen.getByRole('textbox', { name: 'Last name' }), 'x')
    expect(lockBox()).not.toBeInTheDocument()
  })

  it('marks the lock box when the choice was not made', async () => {
    answer(actions.changeRegistrant, {
      data: { error: 'Tick the box to go ahead.', field: 'acceptTransferLock' },
    })
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'x')
    await user.click(screen.getByRole('button', { name: 'Save registrant' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Tick the box to go ahead.')
    expect(lockBox()).toHaveAttribute('aria-invalid', 'true')
  })

  it('marks each field the server refused', async () => {
    answer(actions.changeRegistrant, {
      validationErrors: { registrant: { email: { _errors: ['Enter a valid email address'] } } },
    })
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: 'Save registrant' }))
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Some details need fixing — they’re marked above.')).toBeInTheDocument()
  })
})

describe('RegistrantSummary', () => {
  it('shows who, how to reach them and where, on three lines', () => {
    const { container } = render(
      <RegistrantSummary registrant={{ ...ADA, company: 'Okafor Ltd', addressLine2: 'Suite 4' }} />,
    )
    expect(container).toHaveTextContent(
      'Ada Okafor, Okafor Ltdada@example.com · +234 80312345671 Marina, Suite 4, Lagos, Lagos 100001, NG',
    )
  })

  it('says when nothing is recorded', () => {
    render(<RegistrantSummary registrant={null} />)
    expect(screen.getByText('Not recorded.')).toBeInTheDocument()
  })
})
