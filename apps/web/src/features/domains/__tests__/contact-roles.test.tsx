import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The server action is the network boundary: the form sees only its result.
vi.mock('../actions/settings', () => ({ changeContactRole: vi.fn() }))

const { changeContactRole } = await import('../actions/settings')
const { ContactRoleForm } = await import('../components/contact-role-form')
const { ContactRolesSummary } = await import('../components/contact-roles-summary')

const DOMAIN_ID = '7d7f7a0e-1c61-4c4f-9f7e-0a6a2f9b1a11'
const PROFILE_ID = '22222222-2222-4222-8222-222222222222'
const BOLA = {
  firstName: 'Bola',
  lastName: 'Ade',
  email: 'accounts@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '1 Marina',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}
const CHI = { ...BOLA, firstName: 'Chi', lastName: 'Obi', email: 'tech@example.com' }

const answer = (result: unknown) => vi.mocked(changeContactRole).mockResolvedValue(result as never)

beforeEach(() => vi.mocked(changeContactRole).mockReset())

function renderForm(over: Partial<Parameters<typeof ContactRoleForm>[0]> = {}) {
  render(
    <ContactRoleForm
      domainId={DOMAIN_ID}
      domain="getpaid.com"
      contactRole="billing"
      profiles={[{ id: PROFILE_ID, label: 'Accounts', name: 'Bola Ade' }]}
      start={{ kind: 'registrant' }}
      {...over}
    />,
  )
  return screen.getByRole('form', { name: 'Change the billing contact' })
}

describe('ContactRoleForm (FR-DS1, SEC-2)', () => {
  it('marks each field that needs fixing', async () => {
    const user = userEvent.setup()
    answer({
      validationErrors: {
        choice: { contact: { email: { _errors: ['Enter a valid email address'] } } },
      },
    })
    const form = renderForm({ start: { kind: 'new', values: { ...BOLA, email: 'nope' } } })
    await user.click(within(form).getByRole('button', { name: 'Save billing contact' }))
    expect(await within(form).findByLabelText('Email')).toHaveAccessibleDescription(
      'Enter a valid email address',
    )
    expect(within(form).getByRole('alert')).toHaveTextContent('Some details need fixing')
  })

  it('asks for a code, and comes back here, when the second factor is stale', async () => {
    const user = userEvent.setup()
    answer({
      serverError: "Confirm it's you with the code from your authenticator app to continue.",
    })
    const form = renderForm()
    await user.click(within(form).getByRole('button', { name: 'Save billing contact' }))
    expect(await within(form).findByRole('link', { name: 'Enter a code' })).toHaveAttribute(
      'href',
      `/verify?next=${encodeURIComponent('/app/domains/getpaid.com/contacts')}`,
    )
  })

  it('shows the server’s refusal', async () => {
    const user = userEvent.setup()
    answer({ data: { error: 'That saved contact is no longer on your account.' } })
    const form = renderForm({ start: { kind: 'profile', profileId: PROFILE_ID } })
    await user.click(within(form).getByRole('button', { name: 'Save billing contact' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'That saved contact is no longer on your account.',
    )
  })

  it('sends the role and what was chosen, and says it waits for the registry', async () => {
    const user = userEvent.setup()
    answer({ data: { ok: true } })
    const form = renderForm()
    await user.click(within(form).getByRole('radio', { name: 'A saved contact' }))
    await user.selectOptions(within(form).getByLabelText('Saved contact'), 'Accounts — Bola Ade')
    await user.click(within(form).getByRole('button', { name: 'Save billing contact' }))
    expect(changeContactRole).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      role: 'billing',
      choice: { kind: 'profile', profileId: PROFILE_ID },
    })
    expect(await within(form).findByRole('status')).toHaveTextContent(
      'Saved and sent to the registry. This page shows the billing contact as changed once the registry confirms it.',
    )
    // FR-DS2: the 60-day warning is the registrant's alone.
    expect(within(form).queryByText(/60 days/)).not.toBeInTheDocument()
  })
})

describe('ContactRolesSummary (FR-DS1)', () => {
  it('says in words which roles the registrant holds', () => {
    render(<ContactRolesSummary contacts={{ technical: CHI }} pending={null} />)
    const [administrative, technical, billing] = screen.getAllByRole('definition')
    expect(administrative).toHaveTextContent('Same as the registrant')
    expect(technical).toHaveTextContent('Chi Obi')
    expect(technical).toHaveTextContent('tech@example.com')
    expect(billing).toHaveTextContent('Same as the registrant')
    expect(screen.queryByText('Waiting for the registry')).not.toBeInTheDocument()
  })

  it('shows each role waiting for the registry, and only those', () => {
    render(
      <ContactRolesSummary
        contacts={{ technical: CHI, billing: BOLA }}
        pending={{ administrative: BOLA, billing: { ...BOLA, city: 'lagos' } }}
      />,
    )
    const [administrative, technical, billing] = screen.getAllByRole('definition')
    expect(administrative).toHaveTextContent(
      'Waiting for the registryChanging to these details once the registry confirms them:',
    )
    expect(administrative).toHaveTextContent('Bola Ade')
    expect(technical).toHaveTextContent(
      'Going back to the registrant once the registry confirms it.',
    )
    expect(billing).not.toHaveTextContent('Waiting for the registry')
    // No time is promised: a change the registry accepts but does not show goes to a person.
    expect(
      screen.getByText(
        'We’ve sent this to the registry. If it isn’t showing here within a day, we’ll look into it.',
      ),
    ).toBeInTheDocument()
  })

  it('promises nothing when nothing is waiting, or what is asked for is already held', () => {
    render(<ContactRolesSummary contacts={{ billing: BOLA }} pending={{ billing: BOLA }} />)
    expect(screen.queryByText('Waiting for the registry')).not.toBeInTheDocument()
    expect(screen.queryByText(/within a day/)).not.toBeInTheDocument()
  })
})
