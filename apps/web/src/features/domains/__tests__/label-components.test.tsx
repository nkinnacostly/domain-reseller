import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The server actions are the network boundary: the components see only their results.
vi.mock('../actions/labels', () => ({
  createLabel: vi.fn(),
  updateLabel: vi.fn(),
  deleteLabel: vi.fn(),
  setDomainLabel: vi.fn(),
}))

const actions = await import('../actions/labels')
const { LabelChip, LabelChips } = await import('../components/label-chip')
const { LabelFields, colorFromForm } = await import('../components/label-fields')
const { LabelManager } = await import('../components/label-manager')
const { DomainLabels } = await import('../components/domain-labels')

const DOMAIN_ID = '00000000-0000-4000-8000-000000000001'
const ACME = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Acme', color: 'blue' as const }
const BANKS = { id: '00000000-0000-4000-8000-0000000000a2', name: 'Banks', color: 'red' as const }

const answer = (action: (...args: never[]) => unknown, result: unknown) =>
  vi.mocked(action).mockResolvedValue(result as never)

beforeEach(() => {
  for (const action of Object.values(actions)) vi.mocked(action).mockReset()
})

describe('LabelChip (FR-P3, S8)', () => {
  it('always shows the name — colour is never the only signal', () => {
    render(<LabelChip label={ACME} />)
    const chip = screen.getByText('Acme').closest('[data-label]')
    expect(chip).toHaveAttribute('data-label', 'Acme')
    // Token classes only (S2): the tint and ink of its colour.
    expect(chip).toHaveClass('bg-label-blue', 'text-label-blue-foreground')
  })

  it('lists a domain’s labels, and nothing at all when it has none', () => {
    const { container, rerender } = render(<LabelChips labels={[]} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<LabelChips labels={[ACME, BANKS]} />)
    expect(container).toHaveTextContent('Labels: AcmeBanks')
  })
})

describe('LabelFields', () => {
  it('names each colour beside its swatch, one chosen', () => {
    render(
      <form aria-label="Test">
        <LabelFields idPrefix="t" name="Acme" color="amber" error="Keep it to 30 characters." />
      </form>,
    )
    expect(screen.getByLabelText('Label name')).toHaveValue('Acme')
    expect(screen.getByLabelText('Label name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Keep it to 30 characters.')).toBeInTheDocument()
    const colours = screen.getByRole('group', { name: 'Colour' })
    expect(within(colours).getAllByRole('radio')).toHaveLength(6)
    expect(within(colours).getByRole('radio', { name: 'Amber' })).toBeChecked()
  })

  it('reads the chosen colour back, and falls back to blue', () => {
    const form = new FormData()
    expect(colorFromForm(form)).toBe('blue')
    form.set('color', 'purple')
    expect(colorFromForm(form)).toBe('purple')
    form.set('color', '#123456')
    expect(colorFromForm(form)).toBe('blue')
  })
})

describe('LabelManager', () => {
  it('explains labels when the account has none', () => {
    render(<LabelManager labels={[]} />)
    expect(screen.getByRole('heading', { name: 'No labels yet' })).toBeInTheDocument()
    expect(screen.getByText(/You have 0 labels of 50\./)).toBeInTheDocument()
  })

  it('adds a label with the colour chosen, then says so and clears the form', async () => {
    const user = userEvent.setup()
    answer(actions.createLabel, { data: { ok: true, label: ACME } })
    render(<LabelManager labels={[]} />)
    const form = screen.getByRole('form', { name: 'New label' })
    await user.type(within(form).getByLabelText('Label name'), '  Acme ')
    await user.click(within(form).getByRole('radio', { name: 'Green' }))
    await user.click(within(form).getByRole('button', { name: 'Add label' }))

    expect(actions.createLabel).toHaveBeenCalledWith({ name: 'Acme', color: 'green' })
    expect(await screen.findByRole('status')).toHaveTextContent('Added “Acme”.')
    expect(within(form).getByLabelText('Label name')).toHaveValue('')
  })

  it('says why a label was not added — the server’s reason or the name’s', async () => {
    const user = userEvent.setup()
    answer(actions.createLabel, { data: { error: 'You already have a label called “Acme”.' } })
    render(<LabelManager labels={[{ ...ACME, domainCount: 0 }]} />)
    const form = screen.getByRole('form', { name: 'New label' })
    await user.type(within(form).getByLabelText('Label name'), 'acme')
    await user.click(within(form).getByRole('button', { name: 'Add label' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'You already have a label called “Acme”.',
    )

    answer(actions.createLabel, {
      validationErrors: { name: { _errors: ['Keep it to 30 characters.'] } },
    })
    await user.click(within(form).getByRole('button', { name: 'Add label' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('Keep it to 30 characters.')
  })

  it('offers no new label once the account has 50', () => {
    const fifty = Array.from({ length: 50 }, (_, index) => ({
      id: `id-${index}`,
      name: `Label ${index}`,
      color: 'slate' as const,
      domainCount: 0,
    }))
    render(<LabelManager labels={fifty} />)
    expect(screen.queryByRole('form', { name: 'New label' })).not.toBeInTheDocument()
    expect(screen.getByText(/the most an account can have/)).toBeInTheDocument()
  })

  it('shows where each label is used, and links to those domains', () => {
    render(
      <LabelManager
        labels={[
          { ...ACME, domainCount: 3 },
          { ...BANKS, domainCount: 0 },
        ]}
      />,
    )
    const list = screen.getByRole('list', { name: 'Your labels' })
    expect(within(list).getByText(/On 3 domains\./)).toBeInTheDocument()
    expect(within(list).getByText('Not on any domain yet.')).toBeInTheDocument()
    expect(within(list).getByRole('link', { name: /Show them/ })).toHaveAttribute(
      'href',
      `/app/domains?label=${ACME.id}`,
    )
  })

  it('renames and recolours a label, or leaves it as it was', async () => {
    const user = userEvent.setup()
    answer(actions.updateLabel, { data: { ok: true, label: { ...ACME, name: 'Acme Ltd' } } })
    render(<LabelManager labels={[{ ...ACME, domainCount: 1 }]} />)

    await user.click(screen.getByRole('button', { name: 'Edit Acme' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'Edit Acme' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit Acme' }))
    const form = screen.getByRole('form', { name: 'Edit Acme' })
    await user.clear(within(form).getByLabelText('Label name'))
    await user.type(within(form).getByLabelText('Label name'), 'Acme Ltd')
    await user.click(within(form).getByRole('radio', { name: 'Purple' }))
    await user.click(within(form).getByRole('button', { name: 'Save label' }))

    expect(actions.updateLabel).toHaveBeenCalledWith({
      id: ACME.id,
      name: 'Acme Ltd',
      color: 'purple',
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Saved “Acme Ltd”.')
    expect(screen.queryByRole('form', { name: 'Edit Acme' })).not.toBeInTheDocument()
  })

  it('keeps the form open, saying why, when a rename is refused', async () => {
    const user = userEvent.setup()
    answer(actions.updateLabel, { data: { error: 'You already have a label called “Banks”.' } })
    render(<LabelManager labels={[{ ...ACME, domainCount: 1 }]} />)
    await user.click(screen.getByRole('button', { name: 'Edit Acme' }))
    const form = screen.getByRole('form', { name: 'Edit Acme' })
    await user.click(within(form).getByRole('button', { name: 'Save label' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('called “Banks”')
  })

  it('deletes only after asking, and says what it comes off', async () => {
    const user = userEvent.setup()
    answer(actions.deleteLabel, { data: { ok: true } })
    render(<LabelManager labels={[{ ...ACME, domainCount: 2 }]} />)
    await user.click(screen.getByRole('button', { name: 'Delete Acme' }))
    const confirm = screen.getByRole('group', { name: 'Delete “Acme”?' })
    expect(confirm).toHaveTextContent('It comes off 2 domains.')
    await user.click(within(confirm).getByRole('button', { name: 'Keep it' }))
    expect(actions.deleteLabel).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete Acme' }))
    await user.click(screen.getByRole('button', { name: 'Delete label' }))
    expect(actions.deleteLabel).toHaveBeenCalledWith({ id: ACME.id })
    expect(await screen.findByRole('status')).toHaveTextContent('Deleted “Acme”.')
  })

  it('says why a delete did not happen, and when it could not be sent', async () => {
    const user = userEvent.setup()
    answer(actions.deleteLabel, { data: { error: 'That label is not on your account.' } })
    render(<LabelManager labels={[{ ...ACME, domainCount: 0 }]} />)
    await user.click(screen.getByRole('button', { name: 'Delete Acme' }))
    expect(screen.getByRole('group', { name: 'Delete “Acme”?' })).toHaveTextContent(
      'It is not on any domain.',
    )
    await user.click(screen.getByRole('button', { name: 'Delete label' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That label is not on your account.')

    vi.mocked(actions.deleteLabel).mockRejectedValue(new Error('offline'))
    await user.click(screen.getByRole('button', { name: 'Delete label' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('That did not go through.'),
    )
  })
})

describe('DomainLabels (FR-P3)', () => {
  const renderLabels = (assigned = [ACME], labels = [ACME, BANKS]) =>
    render(
      <DomainLabels
        domainId={DOMAIN_ID}
        domainName="getpaid.com"
        assigned={assigned}
        labels={labels}
      />,
    )

  it('shows the domain’s labels, or says it has none', () => {
    const { unmount } = renderLabels()
    expect(screen.getByText('Labels:').parentElement).toHaveTextContent('Labels: Acme')
    unmount()
    renderLabels([])
    expect(screen.getByText('No labels on getpaid.com yet.')).toBeInTheDocument()
  })

  it('saves each tick at once, and shows it at once', async () => {
    const user = userEvent.setup()
    answer(actions.setDomainLabel, { data: { ok: true } })
    renderLabels()
    const choose = screen.getByRole('button', { name: 'Choose labels' })
    expect(choose).toHaveAttribute('aria-expanded', 'false')
    await user.click(choose)
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('aria-expanded', 'true')

    const group = screen.getByRole('group', { name: 'Labels on getpaid.com' })
    expect(within(group).getByRole('checkbox', { name: 'Acme' })).toBeChecked()
    await user.click(within(group).getByRole('checkbox', { name: 'Banks' }))
    expect(actions.setDomainLabel).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      labelId: BANKS.id,
      on: true,
    })
    expect(within(group).getByRole('checkbox', { name: 'Banks' })).toBeChecked()
  })

  it('puts a tick back, and says why, when it did not save', async () => {
    const user = userEvent.setup()
    answer(actions.setDomainLabel, { data: { error: 'That label is not on your account.' } })
    renderLabels()
    await user.click(screen.getByRole('button', { name: 'Choose labels' }))
    const acme = screen.getByRole('checkbox', { name: 'Acme' })
    await user.click(acme)
    expect(await screen.findByRole('alert')).toHaveTextContent('That label is not on your account.')
    expect(acme).toBeChecked()

    vi.mocked(actions.setDomainLabel).mockResolvedValue({
      serverError: 'Please sign in to continue.',
    } as never)
    await user.click(acme)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Please sign in'))
  })

  it('offers a new label straight away when the account has none', async () => {
    const user = userEvent.setup()
    answer(actions.createLabel, { data: { ok: true, label: ACME } })
    renderLabels([], [])
    const form = screen.getByRole('form', { name: 'New label for this domain' })
    // Nothing to go back to, so no Cancel.
    expect(within(form).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    await user.type(within(form).getByLabelText('Label name'), 'Acme')
    await user.click(within(form).getByRole('button', { name: 'Add to this domain' }))
    expect(actions.createLabel).toHaveBeenCalledWith({
      name: 'Acme',
      color: 'blue',
      domainId: DOMAIN_ID,
    })
    await waitFor(() =>
      expect(
        screen.queryByRole('form', { name: 'New label for this domain' }),
      ).not.toBeInTheDocument(),
    )
  })

  it('opens and closes the new-label form, and links to where labels are managed', async () => {
    const user = userEvent.setup()
    renderLabels()
    await user.click(screen.getByRole('button', { name: 'New label' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.queryByRole('form', { name: 'New label for this domain' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Manage your labels' })).toHaveAttribute(
      'href',
      '/app/settings/labels',
    )
  })
})
