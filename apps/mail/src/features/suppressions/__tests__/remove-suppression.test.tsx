import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeSuppression } from '../actions/suppressions'
import { RemoveSuppression } from '../components/remove-suppression'

/** "Remove", with its warning (MAIL-SPEC §10 Suppressions). */

const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('../actions/suppressions', () => ({ removeSuppression: vi.fn() }))

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})
beforeEach(() => vi.clearAllMocks())

describe('RemoveSuppression', () => {
  it('warns what removing a complainer risks, then removes it', async () => {
    vi.mocked(removeSuppression).mockResolvedValue({ data: { ok: true } } as never)
    const user = userEvent.setup()
    render(
      <RemoveSuppression
        accountId={ACCOUNT}
        suppressionId={12}
        address="ada@example.com"
        reason="complaint"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Remove: ada@example.com' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Remove this address from the list?',
    })
    expect(within(dialog).getByText(/marked as spam/)).toBeInTheDocument()
    expect(within(dialog).getByText(/raises your complaint rate/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Remove from the list' }))
    expect(removeSuppression).toHaveBeenCalledWith({ accountId: ACCOUNT, suppressionId: 12 })
    expect(router.refresh).toHaveBeenCalled()
  })

  it('keeps the dialog open with the refusal; a bounce warns of the bounce rate', async () => {
    vi.mocked(removeSuppression).mockResolvedValue({
      data: { error: 'Amazon SES did not remove the address.' },
    } as never)
    const user = userEvent.setup()
    render(
      <RemoveSuppression
        accountId={ACCOUNT}
        suppressionId={13}
        address="bob@example.com"
        reason="bounce"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Remove/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/because it was bounced/)).toBeInTheDocument()
    expect(within(dialog).getByText(/raises your bounce rate/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Remove from the list' }))
    expect(
      await within(dialog).findByText('Amazon SES did not remove the address.'),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
