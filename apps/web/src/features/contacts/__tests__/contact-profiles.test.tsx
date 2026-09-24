import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactProfile } from '../lib/profiles'

// The server actions are the network boundary: the page sees only their results.
vi.mock('../actions/profiles', () => ({
  saveContactProfile: vi.fn(),
  makeDefaultContactProfile: vi.fn(),
  deleteContactProfile: vi.fn(),
}))

const actions = await import('../actions/profiles')
const { ContactProfiles } = await import('../components/contact-profiles')

const VALUES = {
  firstName: 'Bola',
  lastName: 'Ade',
  company: '',
  email: 'accounts@example.com',
  phoneCountryCode: '234',
  phone: '8039876543',
  addressLine1: '2 Broad Street',
  addressLine2: '',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}
const HOME: ContactProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Registrant',
  isDefault: true,
  values: { ...VALUES, firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com' },
}
const ACCOUNTS: ContactProfile = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Accounts',
  isDefault: false,
  values: VALUES,
}

const answer = (action: (...args: never[]) => unknown, result: unknown) =>
  vi.mocked(action).mockResolvedValue(result as never)

beforeEach(() => {
  for (const action of Object.values(actions)) vi.mocked(action).mockReset()
})

describe('ContactProfiles — empty (FR-A4)', () => {
  it('says there are none yet, and where they come from', () => {
    render(<ContactProfiles profiles={[]} />)
    expect(screen.getByRole('heading', { name: 'No saved contacts yet' })).toBeInTheDocument()
    expect(screen.getByText(/Your first checkout saves the registrant/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Saved contacts' })).not.toBeInTheDocument()
  })

  it('makes the first contact the default unless unticked', async () => {
    const user = userEvent.setup()
    render(<ContactProfiles profiles={[]} />)
    await user.click(screen.getByRole('button', { name: 'Add a contact' }))
    const form = screen.getByRole('form', { name: 'New contact' })
    expect(within(form).getByRole('checkbox', { name: /Use as my default/ })).toBeChecked()
    // FR-A4: a new contact starts Nigerian, with the dialling code that goes with it.
    expect(within(form).getByLabelText('Code')).toHaveValue('234')
    expect(within(form).getByLabelText('Country')).toHaveValue('NG')

    await user.click(within(form).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'New contact' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No saved contacts yet' })).toBeInTheDocument()
  })
})

describe('ContactProfiles — adding and editing', () => {
  it('marks each field that needs fixing, and keeps the form open', async () => {
    const user = userEvent.setup()
    answer(actions.saveContactProfile, {
      validationErrors: {
        label: { _errors: ['Give this contact a name'] },
        contact: { city: { _errors: ['Enter a city'] } },
      },
    })
    render(<ContactProfiles profiles={[HOME]} />)
    await user.click(screen.getByRole('button', { name: 'Add a contact' }))
    const form = screen.getByRole('form', { name: 'New contact' })
    expect(within(form).getByRole('checkbox', { name: /Use as my default/ })).not.toBeChecked()
    await user.click(within(form).getByRole('button', { name: 'Save contact' }))

    expect(await within(form).findByLabelText('Name for this contact')).toHaveAccessibleDescription(
      'Give this contact a name',
    )
    expect(within(form).getByLabelText('City')).toHaveAttribute('aria-invalid', 'true')
    expect(within(form).getByRole('alert')).toHaveTextContent('Some details need fixing')
  })

  it('shows why the server refused it', async () => {
    const user = userEvent.setup()
    answer(actions.saveContactProfile, { data: { error: 'You can save up to 25 contacts.' } })
    render(<ContactProfiles profiles={[HOME]} />)
    await user.click(screen.getByRole('button', { name: 'Add a contact' }))
    const form = screen.getByRole('form', { name: 'New contact' })
    await user.click(within(form).getByRole('button', { name: 'Save contact' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'You can save up to 25 contacts.',
    )
  })

  it('sends what was typed, and says it was saved', async () => {
    const user = userEvent.setup()
    answer(actions.saveContactProfile, { data: { ok: true } })
    render(<ContactProfiles profiles={[HOME]} />)
    await user.click(screen.getByRole('button', { name: 'Add a contact' }))
    const form = screen.getByRole('form', { name: 'New contact' })
    await user.type(within(form).getByLabelText('Name for this contact'), '  Accounts ')
    await user.type(within(form).getByLabelText('First name'), 'Bola')
    await user.click(within(form).getByRole('button', { name: 'Save contact' }))

    expect(actions.saveContactProfile).toHaveBeenCalledWith({
      label: 'Accounts',
      isDefault: false,
      contact: expect.objectContaining({ firstName: 'Bola', phoneCountryCode: '234' }),
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Saved “Accounts”.')
    expect(screen.queryByRole('form', { name: 'New contact' })).not.toBeInTheDocument()
  })

  it('edits a profile from its saved details, and cancels without saving', async () => {
    const user = userEvent.setup()
    answer(actions.saveContactProfile, { data: { ok: true } })
    render(<ContactProfiles profiles={[HOME, ACCOUNTS]} />)
    await user.click(screen.getByRole('button', { name: 'Edit Accounts' }))
    const form = screen.getByRole('form', { name: 'Edit Accounts' })
    expect(within(form).getByLabelText('Name for this contact')).toHaveValue('Accounts')
    expect(within(form).getByLabelText('Email')).toHaveValue('accounts@example.com')
    await user.click(within(form).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'Edit Accounts' })).not.toBeInTheDocument()
    expect(actions.saveContactProfile).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Edit Accounts' }))
    await user.click(screen.getByRole('button', { name: 'Save contact' }))
    expect(actions.saveContactProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACCOUNTS.id, label: 'Accounts', isDefault: false }),
    )
  })
})

describe('ContactProfiles — the list', () => {
  it('shows each profile, and which is the default in words (S8)', () => {
    render(<ContactProfiles profiles={[HOME, ACCOUNTS]} />)
    const list = screen.getByRole('list', { name: 'Saved contacts' })
    const [home, accounts] = within(list).getAllByRole('listitem')
    expect(home).toHaveTextContent('Default')
    expect(home).toHaveTextContent('Checkout fills in the registrant from it.')
    expect(accounts).toHaveTextContent('Bola Ade')
    expect(accounts).not.toHaveTextContent('Default')
    expect(
      within(home as HTMLElement).queryByRole('button', { name: /the default/ }),
    ).not.toBeInTheDocument()
  })

  it('makes a profile the default, and says so', async () => {
    const user = userEvent.setup()
    answer(actions.makeDefaultContactProfile, { data: { ok: true } })
    render(<ContactProfiles profiles={[HOME, ACCOUNTS]} />)
    await user.click(screen.getByRole('button', { name: 'Make Accounts the default' }))
    expect(actions.makeDefaultContactProfile).toHaveBeenCalledWith({ id: ACCOUNTS.id })
    expect(await screen.findByRole('status')).toHaveTextContent(
      '“Accounts” is now your default contact.',
    )
  })

  it('shows a refusal on the profile it was about', async () => {
    const user = userEvent.setup()
    vi.mocked(actions.makeDefaultContactProfile).mockRejectedValue(new Error('offline'))
    render(<ContactProfiles profiles={[HOME, ACCOUNTS]} />)
    await user.click(screen.getByRole('button', { name: 'Make Accounts the default' }))
    const accounts = screen.getAllByRole('listitem')[1] as HTMLElement
    expect(await within(accounts).findByRole('alert')).toBeInTheDocument()
  })

  it('asks before deleting, and can be talked out of it', async () => {
    const user = userEvent.setup()
    render(<ContactProfiles profiles={[HOME, ACCOUNTS]} />)
    await user.click(screen.getByRole('button', { name: 'Delete Accounts' }))
    const confirm = screen.getByRole('group', { name: 'Delete “Accounts”?' })
    expect(confirm).toHaveTextContent('keep their own copy')
    await user.click(within(confirm).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('group', { name: 'Delete “Accounts”?' })).not.toBeInTheDocument()
    expect(actions.deleteContactProfile).not.toHaveBeenCalled()
  })

  it('deletes once confirmed, or says why it could not', async () => {
    const user = userEvent.setup()
    answer(actions.deleteContactProfile, { data: { error: 'That contact is no longer here.' } })
    render(<ContactProfiles profiles={[HOME, ACCOUNTS]} />)
    await user.click(screen.getByRole('button', { name: 'Delete Accounts' }))
    await user.click(screen.getByRole('button', { name: 'Delete contact' }))
    expect(actions.deleteContactProfile).toHaveBeenCalledWith({ id: ACCOUNTS.id })
    expect(await screen.findByRole('alert')).toHaveTextContent('That contact is no longer here.')

    answer(actions.deleteContactProfile, { data: { ok: true } })
    await user.click(screen.getByRole('button', { name: 'Delete contact' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Deleted “Accounts”.'))
  })
})
