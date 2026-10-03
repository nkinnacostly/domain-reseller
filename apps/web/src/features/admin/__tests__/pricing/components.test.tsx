import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateFxRate,
  rejectFxRate,
  updatePricingSettings,
} from '@/features/admin/actions/pricing'
import { RateActions } from '@/features/admin/components/pricing/rate-actions'
import { SettingsForm } from '@/features/admin/components/pricing/settings-form'
import { SERVER_CRASH_WORDS } from '@/features/admin/lib/errors'
import { rejectCopy } from '@/features/admin/lib/pricing-copy'
import { comSample, FRESH_ID, settings, staleRow } from './fixtures'

/**
 * The Pricing & FX controls (docs/ADMIN-SPEC.md §5.2 B12): the settings form
 * — refused values in words, Save only once something changed, a dialog
 * that shows before → after and the effect on .com with its renewal — and
 * a held rate's Activate and Reject, each a money action with a reason and
 * the authenticator code. A refusal is shown in the dialog, in words.
 */

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/actions/pricing', () => ({
  updatePricingSettings: vi.fn(),
  activateFxRate: vi.fn(),
  rejectFxRate: vi.fn(),
}))

const REASON = 'The buffer no longer covers settlement'
const ROLE_WORDS = "Your admin role can't do this. Ask the owner."
const answer = (data: unknown) => ({ data }) as never

beforeEach(() => vi.clearAllMocks())

function renderForm(ownerOnly = false) {
  const user = userEvent.setup()
  render(
    <SettingsForm
      settings={settings()}
      sample={comSample()}
      active={{ costingRate: 1330.5689, bufferPct: 0 }}
      ownerOnly={ownerOnly}
    />,
  )
  return user
}

const field = (name: RegExp) => screen.getByRole('textbox', { name })
const saveButton = () => screen.getByRole('button', { name: 'Save changes' })

describe('the settings form', () => {
  it('shows the stored values, and offers Save only once something changed', async () => {
    const user = renderForm()
    expect(field(/^Margin/)).toHaveValue('4250')
    expect(field(/^FX buffer/)).toHaveValue('1.5')
    expect(field(/^ICANN fee/)).toHaveValue('18')
    expect(field(/^Move threshold/)).toHaveValue('6.5')
    expect(screen.queryByRole('textbox', { name: /VAT/ })).toBeNull()
    expect(saveButton()).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Change a value to save it.')
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled()

    await user.clear(field(/^Margin/))
    await user.type(field(/^Margin/), '5,000')
    expect(saveButton()).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('1 change ready to save.')
  })

  it('refuses a value outside its bounds, in words tied to the field, and will not save', async () => {
    const user = renderForm()
    await user.clear(field(/^FX buffer/))
    await user.type(field(/^FX buffer/), '25')
    expect(field(/^FX buffer/)).toHaveAttribute('aria-invalid', 'true')
    expect(field(/^FX buffer/)).toHaveAccessibleDescription(
      'Enter 0% to 20%, with at most 2 decimal places.',
    )
    expect(saveButton()).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Fix the values marked above to save.')

    await user.click(screen.getByRole('button', { name: 'Undo changes' }))
    expect(field(/^FX buffer/)).toHaveValue('1.5')
    expect(field(/^FX buffer/)).not.toHaveAttribute('aria-invalid')
  })

  it('says to a non-owner, before any code is typed, that only the owner saves', () => {
    renderForm(true)
    expect(screen.getByText('Only the owner can save these settings.')).toBeInTheDocument()
  })

  it('asks with before → after and the effect on .com and its renewal, then saves the changes alone', async () => {
    vi.mocked(updatePricingSettings).mockResolvedValue(answer({ ok: true, auditId: 41 }))
    const user = renderForm()
    await user.clear(field(/^Margin/))
    await user.type(field(/^Margin/), '5000')
    await user.click(saveButton())

    const dialog = screen.getByRole('dialog', { name: 'Change 1 pricing setting?' })
    expect(within(dialog).getByText('₦4,250 → ₦5,000')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        '.com: ₦19,600 → ₦20,300 first year; renews at ₦19,900 → ₦20,600/yr',
      ),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'Prices on the site change on the next refresh, within minutes. Orders already placed keep their prices.',
      ),
    ).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    await user.click(within(dialog).getByRole('button', { name: 'Save settings' }))

    expect(updatePricingSettings).toHaveBeenCalledWith({
      changes: { margin_ngn: 5000 },
      reason: REASON,
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      code: '123456',
    })
    expect(
      await within(dialog).findByText('Saved. Prices on the site update on the next refresh.'),
    ).toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
  })

  it('shows the role’s refusal in the dialog, and changes nothing on the page', async () => {
    vi.mocked(updatePricingSettings).mockResolvedValue({ serverError: ROLE_WORDS } as never)
    const user = renderForm(true)
    await user.clear(field(/^Move threshold/))
    await user.type(field(/^Move threshold/), '7')
    await user.click(saveButton())
    const dialog = screen.getByRole('dialog', { name: 'Change 1 pricing setting?' })
    expect(within(dialog).queryByText(/^Effect$/)).toBeNull()
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    await user.click(within(dialog).getByRole('button', { name: 'Save settings' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(ROLE_WORDS)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("a held rate's actions", () => {
  const reject = rejectCopy({ rate: staleRow(), reviewReason: 'Moved too far', active: null })
  const activate = {
    title: 'Charge at ₦1,523.40 to the dollar?',
    rows: [{ label: 'Move', value: '+14.5%' }],
    body: 'Every price on the site changes on the next refresh, within minutes. Orders already placed keep their rate.',
    confirmLabel: 'Activate rate',
    cancelLabel: 'Not now',
    success: 'Activated. Prices on the site update on the next refresh.',
  }

  it('offers Reject alone for a rate that may not be activated, named for that rate', () => {
    render(<RateActions rateId={FRESH_ID} rateLabel="₦1,700.00" activate={null} reject={reject} />)
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reject ₦1,700.00' })).toBeInTheDocument()
  })

  it('activates with a reason and the code, and says so', async () => {
    vi.mocked(activateFxRate).mockResolvedValue(answer({ ok: true, auditId: 9 }))
    const user = userEvent.setup()
    render(
      <RateActions rateId={FRESH_ID} rateLabel="₦1,523.40" activate={activate} reject={reject} />,
    )
    await user.click(screen.getByRole('button', { name: 'Activate ₦1,523.40' }))
    const dialog = screen.getByRole('dialog', { name: 'Charge at ₦1,523.40 to the dollar?' })
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '654321')
    await user.click(within(dialog).getByRole('button', { name: 'Activate rate' }))
    expect(activateFxRate).toHaveBeenCalledWith({
      rateId: FRESH_ID,
      reason: REASON,
      requestKey: expect.any(String),
      code: '654321',
    })
    expect(await within(dialog).findByRole('status')).toHaveTextContent(activate.success)
  })

  it('rejects from a dialog that focuses Cancel first, and keeps the key after a lost answer', async () => {
    vi.mocked(rejectFxRate).mockResolvedValue({ serverError: SERVER_CRASH_WORDS } as never)
    const user = userEvent.setup()
    render(<RateActions rateId={FRESH_ID} rateLabel="₦1,700.00" activate={null} reject={reject} />)
    await user.click(screen.getByRole('button', { name: 'Reject ₦1,700.00' }))
    const dialog = screen.getByRole('dialog', { name: 'Reject the ₦1,700.00 rate?' })
    expect(within(dialog).getByRole('button', { name: 'Keep it held' })).toHaveFocus()
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '111111')
    await user.click(within(dialog).getByRole('button', { name: 'Reject rate' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "We couldn't tell whether that went through.",
    )
    const first = vi.mocked(rejectFxRate).mock.calls[0]?.[0]
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '222222')
    await user.click(within(dialog).getByRole('button', { name: 'Reject rate' }))
    const second = vi.mocked(rejectFxRate).mock.calls[1]?.[0]
    expect(second?.requestKey).toBe(first?.requestKey)
  })
})
