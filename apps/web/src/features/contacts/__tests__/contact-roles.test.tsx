import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ContactRoles } from '../components/contact-roles'
import { RoleChoiceFields } from '../components/role-choice-fields'
import type { ProfileOption } from '../lib/profiles'
import { contactRolesFromForm, roleChoiceFromForm } from '../lib/roles'

const PROFILES: ProfileOption[] = [
  { id: '22222222-2222-4222-8222-222222222222', label: 'Accounts', name: 'Bola Ade' },
  { id: '33333333-3333-4333-8333-333333333333', label: 'Chi Obi', name: 'Chi Obi' },
]

/** What the surrounding form would send, read the way checkout reads it. */
const sent = () => new FormData(screen.getByRole('form') as HTMLFormElement)

function inForm(children: React.ReactNode) {
  return render(
    <form aria-label="Test form" noValidate>
      {children}
    </form>,
  )
}

/** Opens a closed details section the way a click on its summary does. */
async function openSection(user: ReturnType<typeof userEvent.setup>) {
  const summary = screen.getByText('Different contacts for administrative, technical or billing?')
  await user.click(summary)
  const details = summary.closest('details') as HTMLDetailsElement
  if (!details.open) {
    await act(async () => {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
  }
}

describe('RoleChoiceFields (FR-A4, FR-DS1)', () => {
  it('starts as the registrant, naming the role and what it is for', () => {
    inForm(<RoleChoiceFields contactRole="billing" profiles={PROFILES} />)
    const group = screen.getByRole('group', { name: 'Billing contact' })
    expect(group).toHaveAccessibleDescription('Who to contact about paying for the domain.')
    expect(within(group).getByRole('radio', { name: 'Same as the registrant' })).toBeChecked()
    expect(roleChoiceFromForm(sent())).toEqual({ kind: 'registrant' })
  })

  it('offers saved contacts only when there are some', () => {
    inForm(<RoleChoiceFields contactRole="technical" profiles={[]} />)
    expect(screen.queryByRole('radio', { name: 'A saved contact' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
  })

  it('picks a saved contact by its name', async () => {
    const user = userEvent.setup()
    inForm(<RoleChoiceFields contactRole="billing" profiles={PROFILES} />)
    await user.click(screen.getByRole('radio', { name: 'A saved contact' }))
    const select = screen.getByLabelText('Saved contact')
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose a saved contact', 'Accounts — Bola Ade', 'Chi Obi'])
    await user.selectOptions(select, 'Accounts — Bola Ade')
    expect(roleChoiceFromForm(sent())).toEqual({ kind: 'profile', profileId: PROFILES[0]?.id })
  })

  it('shows new details only once chosen, with the registrant’s fields', async () => {
    const user = userEvent.setup()
    inForm(<RoleChoiceFields contactRole="billing" namePrefix="billing." profiles={PROFILES} />)
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'New details' }))
    await user.type(screen.getByLabelText('First name'), 'Chi')
    const choice = roleChoiceFromForm(sent(), 'billing.')
    expect(choice).toMatchObject({ kind: 'new', contact: { firstName: 'Chi', country: 'NG' } })
  })

  it('starts from a role’s current holder: a saved contact, or its own details', () => {
    const { unmount } = inForm(
      <RoleChoiceFields
        contactRole="billing"
        profiles={PROFILES}
        start={{ kind: 'profile', profileId: PROFILES[1]?.id as string }}
      />,
    )
    expect(screen.getByLabelText('Saved contact')).toHaveValue(PROFILES[1]?.id)
    unmount()
    inForm(
      <RoleChoiceFields
        contactRole="billing"
        profiles={PROFILES}
        start={{ kind: 'new', values: { firstName: 'Tola', country: 'GH' } }}
      />,
    )
    expect(screen.getByLabelText('First name')).toHaveValue('Tola')
    expect(screen.getByLabelText('Country')).toHaveValue('GH')
  })

  it('falls back to the registrant when the saved contact it started from is gone', () => {
    inForm(
      <RoleChoiceFields
        contactRole="billing"
        profiles={[]}
        start={{ kind: 'profile', profileId: PROFILES[0]?.id as string }}
      />,
    )
    expect(screen.getByRole('radio', { name: 'Same as the registrant' })).toBeChecked()
  })

  it('shows a problem with the role beside it', async () => {
    const user = userEvent.setup()
    inForm(
      <RoleChoiceFields
        contactRole="billing"
        profiles={PROFILES}
        start={{ kind: 'profile', profileId: '' }}
        profileError="Choose a saved contact"
        problem="Billing contact: That saved contact is no longer on your account."
      />,
    )
    expect(screen.getByLabelText('Saved contact')).toHaveAccessibleDescription(
      'Choose a saved contact',
    )
    expect(screen.getByRole('group', { name: 'Billing contact' })).toHaveAccessibleDescription(
      /no longer on your account/,
    )
    await user.click(screen.getByRole('radio', { name: 'Same as the registrant' }))
    expect(screen.queryByLabelText('Saved contact')).not.toBeInTheDocument()
  })
})

describe('ContactRoles at checkout (FR-C5, FR-A4)', () => {
  it('is collapsed, sending nothing, until opened', () => {
    inForm(<ContactRoles profiles={PROFILES} />)
    const summary = screen.getByText('Different contacts for administrative, technical or billing?')
    expect(summary.closest('details')).not.toHaveAttribute('open')
    expect(screen.queryByRole('group', { name: 'Billing contact' })).not.toBeInTheDocument()
    expect(contactRolesFromForm(sent())).toBeUndefined()
  })

  it('offers all three roles, each starting as the registrant', async () => {
    const user = userEvent.setup()
    inForm(<ContactRoles profiles={PROFILES} />)
    await openSection(user)
    for (const role of ['Administrative', 'Technical', 'Billing']) {
      const group = screen.getByRole('group', { name: `${role} contact` })
      expect(within(group).getByRole('radio', { name: 'Same as the registrant' })).toBeChecked()
    }
    expect(contactRolesFromForm(sent())).toBeUndefined()
  })

  it('sends a role given to someone else, and keeps it when the section is closed', async () => {
    const user = userEvent.setup()
    inForm(<ContactRoles profiles={PROFILES} />)
    await openSection(user)
    const billing = screen.getByRole('group', { name: 'Billing contact' })
    await user.click(within(billing).getByRole('radio', { name: 'New details' }))
    await user.type(within(billing).getByLabelText('First name'), 'Chi')
    const details = billing.closest('details') as HTMLDetailsElement
    await act(async () => {
      details.open = false
      details.dispatchEvent(new Event('toggle'))
    })
    expect(contactRolesFromForm(sent())).toEqual({
      billing: { kind: 'new', contact: expect.objectContaining({ firstName: 'Chi' }) },
    })
  })

  it('opens itself on a problem, and shows each beside its role', () => {
    inForm(
      <ContactRoles
        profiles={PROFILES}
        errors={{
          contacts: { technical: { contact: { city: { _errors: ['Enter a city'] } } } },
        }}
        failure={{
          error: 'Billing contact: That saved contact is gone.',
          field: 'contacts.billing',
        }}
      />,
    )
    const summary = screen.getByText('Different contacts for administrative, technical or billing?')
    expect(summary.closest('details')).toHaveAttribute('open')
    expect(screen.getByRole('group', { name: 'Billing contact' })).toHaveAccessibleDescription(
      /That saved contact is gone/,
    )
    expect(
      screen.getByRole('group', { name: 'Technical contact' }),
    ).not.toHaveAccessibleDescription(/gone/)
  })

  it('ignores a refusal about something else', () => {
    inForm(<ContactRoles profiles={PROFILES} failure={{ error: 'Nope', field: 'presetId' }} />)
    const summary = screen.getByText('Different contacts for administrative, technical or billing?')
    expect(summary.closest('details')).not.toHaveAttribute('open')
  })
})
