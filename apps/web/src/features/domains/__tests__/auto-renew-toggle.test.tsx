import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The server action is the network boundary: the component sees only its result.
vi.mock('../actions/domains', () => ({ setAutoRenew: vi.fn(), requestNameservers: vi.fn() }))

const { setAutoRenew } = await import('../actions/domains')
const { AutoRenewToggle } = await import('../components/auto-renew-toggle')

const DOMAIN_ID = '7d7f7a0e-1c61-4c4f-9f7e-0a6a2f9b1a11'
const answer = (result: unknown) => vi.mocked(setAutoRenew).mockResolvedValue(result as never)

function toggle() {
  return screen.getByRole('switch', { name: 'Renew automatically' })
}

beforeEach(() => vi.mocked(setAutoRenew).mockReset())

describe('AutoRenewToggle (FR-RN2)', () => {
  it('shows the current choice, the renewal price, and that automatic renewal is not live yet', () => {
    render(<AutoRenewToggle domainId={DOMAIN_ID} autoRenew renewal="₦21,500" />)
    expect(toggle()).toBeChecked()
    expect(toggle()).toHaveAccessibleDescription(
      'At ₦21,500/yr. Automatic renewal isn’t switched on yet — this records what you want. Until it is, renew from the Renew tab.',
    )
  })

  it('says nothing about price when there is none to quote', () => {
    render(<AutoRenewToggle domainId={DOMAIN_ID} autoRenew={false} renewal={null} />)
    expect(toggle()).not.toBeChecked()
    expect(toggle()).toHaveAccessibleDescription(
      'Automatic renewal isn’t switched on yet — this records what you want. Until it is, renew from the Renew tab.',
    )
  })

  it('records the new choice and keeps it once it is saved', async () => {
    answer({ data: { ok: true } })
    const user = userEvent.setup()
    render(<AutoRenewToggle domainId={DOMAIN_ID} autoRenew renewal="₦21,500" />)

    await user.click(toggle())

    expect(setAutoRenew).toHaveBeenCalledWith({ domainId: DOMAIN_ID, autoRenew: false })
    await waitFor(() => expect(toggle()).toBeEnabled())
    expect(toggle()).not.toBeChecked()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('can be switched on by clicking its label, too', async () => {
    answer({ data: { ok: true } })
    const user = userEvent.setup()
    render(<AutoRenewToggle domainId={DOMAIN_ID} autoRenew={false} renewal={null} />)

    await user.click(screen.getByText('Renew automatically'))

    expect(setAutoRenew).toHaveBeenCalledWith({ domainId: DOMAIN_ID, autoRenew: true })
    await waitFor(() => expect(toggle()).toBeEnabled())
    expect(toggle()).toBeChecked()
  })

  it('puts the switch back and says why when the change was refused', async () => {
    answer({ data: { error: 'That domain is not on your account.' } })
    const user = userEvent.setup()
    render(<AutoRenewToggle domainId={DOMAIN_ID} autoRenew renewal={null} />)

    await user.click(toggle())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That domain is not on your account.',
    )
    await waitFor(() => expect(toggle()).toBeChecked())
  })

  it('puts the switch back and says why when the server fails', async () => {
    answer({ serverError: 'Something went wrong. Please try again.' })
    const user = userEvent.setup()
    render(<AutoRenewToggle domainId={DOMAIN_ID} autoRenew={false} renewal={null} />)

    await user.click(toggle())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    await waitFor(() => expect(toggle()).not.toBeChecked())
  })

  it('cannot be pressed twice while a change is saving', async () => {
    let settle: (value: unknown) => void = () => {}
    vi.mocked(setAutoRenew).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      }) as never,
    )
    const user = userEvent.setup()
    render(<AutoRenewToggle domainId={DOMAIN_ID} autoRenew renewal={null} />)

    await user.click(toggle())

    expect(toggle()).toBeDisabled()
    expect(toggle()).not.toBeChecked()
    await user.click(toggle())
    settle({ data: { ok: true } })
    await waitFor(() => expect(toggle()).toBeEnabled())
    expect(setAutoRenew).toHaveBeenCalledTimes(1)
  })
})
