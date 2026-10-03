import type { AdminFlwRefundCheck } from '@dr/shared/admin'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveIncident, resolveMoneyIncident } from '@/features/admin/actions/incidents'
import {
  approveRefund,
  cancelRefund,
  recordManualRefund,
  retryRefund,
} from '@/features/admin/actions/refunds'
import { checkFlutterwaveRefund } from '@/features/admin/actions/supplier-live'
import { FlwCheck, useNow } from '@/features/admin/components/refunds/flw-check'
import { RecordRefund } from '@/features/admin/components/refunds/record-refund'
import { RefundActions } from '@/features/admin/components/refunds/refund-actions'
import { ResolveIncident } from '@/features/admin/components/refunds/resolve-incident'

/**
 * The refund and incident controls (ADMIN-SPEC §5.2 B3): the dialogs show
 * the limits they were given, Cancel asks for everything it should, and the
 * record step stays shut until a matching, fresh Flutterwave check backs it.
 */

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/actions/refunds', () => ({
  approveRefund: vi.fn(),
  retryRefund: vi.fn(),
  cancelRefund: vi.fn(),
  recordManualRefund: vi.fn(),
}))
vi.mock('@/features/admin/actions/incidents', () => ({
  resolveIncident: vi.fn(),
  resolveMoneyIncident: vi.fn(),
}))
vi.mock('@/features/admin/actions/supplier-live', () => ({ checkFlutterwaveRefund: vi.fn() }))

const REFUND = '6f1d2c3b-4a59-4687-9a1b-2c3d4e5f6a7b'
const LIMITS = { singleKobo: 12_345_600, dailyKobo: 98_765_400, delayMinutes: 17 }
const REASON = 'Checked the order and the charge'
const ok = { data: { ok: true as const, auditId: 1 } }

const refund = {
  id: REFUND,
  amountKobo: 1_967_250,
  status: 'held',
  lastErrorCode: 'OVER_DAILY_LIMIT',
  orderNumber: 'ND-001234',
  forWhat: 'Registration of example.com',
  providerCalled: false,
}

const check = (overrides: Partial<AdminFlwRefundCheck> = {}): AdminFlwRefundCheck => ({
  checkId: 7,
  flwRefundId: 'RF-123',
  transactionId: '456',
  amountKobo: 1_967_250,
  status: 'completed-mpgs',
  state: 'done',
  readAt: new Date().toISOString(),
  ...overrides,
})

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

describe('RefundActions', () => {
  it('shows only the buttons it was given', () => {
    render(
      <RefundActions
        refund={refund}
        offers={{ approve: true, retry: false, cancel: false }}
        limits={LIMITS}
        sent24hKobo={4_321_050}
      />,
    )
    expect(screen.getByRole('button', { name: 'Approve refund' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel refund' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry refund' })).not.toBeInTheDocument()
  })

  it('approves with the limits it was given, a reason and the code', async () => {
    vi.mocked(approveRefund).mockResolvedValue(ok as never)
    const user = userEvent.setup()
    render(
      <RefundActions
        refund={refund}
        offers={{ approve: true, retry: false, cancel: false }}
        limits={LIMITS}
        sent24hKobo={4_321_050}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Approve refund' }))
    const dialog = screen.getByRole('dialog', { name: 'Approve this refund?' })
    expect(within(dialog).getByText('ND-001234')).toBeInTheDocument()
    expect(within(dialog).getByText('Registration of example.com')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'Over the ₦987,654 daily automatic limit — ₦43,210.50 already sent in the last 24 hours',
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Keep it held' })).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Approve ₦19,672.50 refund' })
    expect(confirm).toBeDisabled()

    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    await user.click(confirm)
    expect(approveRefund).toHaveBeenCalledWith({
      refundId: REFUND,
      reason: REASON,
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      code: '123456',
    })
    expect(await within(dialog).findByRole('status')).toHaveTextContent(/Approved/)
    expect(refresh).toHaveBeenCalled()
  })

  it('warns that a retry bypasses both limits, and asks for the dashboard check once Flutterwave was called', async () => {
    vi.mocked(retryRefund).mockResolvedValue(ok as never)
    const user = userEvent.setup()
    render(
      <RefundActions
        refund={{
          ...refund,
          status: 'failed',
          lastErrorCode: 'FLW_HTTP_400',
          providerCalled: true,
        }}
        offers={{ approve: false, retry: true, cancel: false }}
        limits={LIMITS}
        sent24hKobo={0}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Retry refund' }))
    const dialog = screen.getByRole('dialog', { name: 'Send this refund again?' })
    expect(
      within(dialog).getByText(
        "Retrying approves it: the ₦123,456 per-refund and ₦987,654 daily automatic limits won't hold it again.",
      ),
    ).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    const confirm = within(dialog).getByRole('button', { name: 'Retry ₦19,672.50 refund' })
    expect(confirm).toBeDisabled()
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: 'I checked the Flutterwave dashboard: no refund of this charge went through.',
      }),
    )
    await user.click(confirm)
    expect(retryRefund).toHaveBeenCalledWith(expect.objectContaining({ checkedProvider: true }))
  })

  it('cancels only with the note, both ticks, the order number typed back and the code; Cancel is focused first', async () => {
    vi.mocked(cancelRefund).mockResolvedValue({
      data: {
        ok: false,
        code: 'HAS_PROVIDER_REFUND',
        message: 'Flutterwave has a refund for this.',
      },
    } as never)
    const user = userEvent.setup()
    render(
      <RefundActions
        refund={{
          ...refund,
          status: 'failed',
          lastErrorCode: 'CHARGE_NOT_OURS',
          providerCalled: true,
        }}
        offers={{ approve: false, retry: false, cancel: true }}
        limits={LIMITS}
        sent24hKobo={0}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Cancel refund' }))
    const dialog = screen.getByRole('dialog', { name: 'Cancel this refund?' })
    expect(within(dialog).getByRole('button', { name: 'Keep refund' })).toHaveFocus()
    const confirm = within(dialog).getByRole('button', { name: 'Cancel refund — nothing sent' })

    await user.type(within(dialog).getByLabelText('What happened'), 'The bank reversed the charge')
    await user.type(within(dialog).getByLabelText(/to confirm/), 'ND-001234')
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: "We haven't returned this money through Flutterwave, and won't.",
      }),
    )
    expect(confirm).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox', { name: /I checked the Flutterwave/ }))
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(cancelRefund).toHaveBeenCalledWith({
      refundId: REFUND,
      note: 'The bank reversed the charge',
      noMoneyMoved: true,
      checkedProvider: true,
      requestKey: expect.any(String),
      code: '123456',
    })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Flutterwave has a refund for this.',
    )
  })
})

describe('RecordRefund: the record step stays shut without a matching check', () => {
  const recordButton = () => screen.getByRole('button', { name: 'Record ₦19,672.50 as refunded' })
  const withCharge = { ...refund, providerReference: '456' }

  /** Opens the dialog, where the check and the record both sit. */
  async function open(props: typeof withCharge = withCharge) {
    const user = userEvent.setup()
    render(<RecordRefund refund={props} />)
    await user.click(screen.getByRole('button', { name: 'Check and record a Flutterwave refund' }))
    return { user, dialog: screen.getByRole('dialog', { name: 'Record this Flutterwave refund?' }) }
  }

  async function checkWith(answer: unknown, props: typeof withCharge = withCharge) {
    vi.mocked(checkFlutterwaveRefund).mockResolvedValue(answer as never)
    const opened = await open(props)
    await opened.user.type(within(opened.dialog).getByLabelText('Flutterwave refund id'), 'RF-123')
    await opened.user.click(
      within(opened.dialog).getByRole('button', { name: 'Check with Flutterwave' }),
    )
    return opened
  }

  it('opens with the check inside, disabled before any check, and says why', async () => {
    const { dialog } = await open()
    expect(within(dialog).getByText('Charge')).toBeInTheDocument()
    expect(within(dialog).getByText('456')).toBeInTheDocument()
    expect(recordButton()).toBeDisabled()
    expect(within(dialog).getByText(/Check the refund with Flutterwave first/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Check with Flutterwave' })).toBeDisabled()
  })

  it('stays disabled for another amount, and says so', async () => {
    await checkWith({ data: { ok: true, auditId: 3, data: check({ amountKobo: 1_000_000 }) } })
    expect(await screen.findByText(/Does not match/)).toBeInTheDocument()
    expect(screen.getByText("It is for ₦10,000, not this refund's ₦19,672.50.")).toBeInTheDocument()
    expect(recordButton()).toBeDisabled()
    expect(checkFlutterwaveRefund).toHaveBeenCalledWith({ flwRefundId: 'RF-123', refundId: REFUND })
  })

  it("stays disabled for a refund on another charge than the order's", async () => {
    await checkWith({ data: { ok: true, auditId: 3, data: check({ transactionId: '999' }) } })
    expect(
      await screen.findByText("It is on charge 999, not this refund's charge 456."),
    ).toBeInTheDocument()
    expect(recordButton()).toBeDisabled()
  })

  it('stays disabled for a refund Flutterwave has not finished', async () => {
    await checkWith({ data: { ok: true, auditId: 3, data: check({ state: 'pending' }) } })
    expect(await screen.findByText(/hasn't finished this refund yet/)).toBeInTheDocument()
    expect(recordButton()).toBeDisabled()
  })

  it('shows a refused check in words and stays disabled', async () => {
    const { dialog } = await checkWith({
      data: {
        ok: false,
        code: 'FLW_REFUND_NOT_FOUND',
        message: 'Flutterwave has no refund with that id.',
      },
    })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Flutterwave has no refund with that id.',
    )
    expect(recordButton()).toBeDisabled()
  })

  it('opens for a matching, fresh check on the charge and records against it', async () => {
    vi.mocked(recordManualRefund).mockResolvedValue(ok as never)
    const { user, dialog } = await checkWith({ data: { ok: true, auditId: 3, data: check() } })
    expect(
      await within(dialog).findByText(
        'Flutterwave refund RF-123: ₦19,672.50 on charge 456, completed — matches this refund',
      ),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        "Nothing is sent. The customer's order page will show ₦19,672.50 as refunded.",
      ),
    ).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '654321')
    expect(recordButton()).toBeEnabled()
    await user.click(recordButton())
    expect(recordManualRefund).toHaveBeenCalledWith({
      refundId: REFUND,
      checkId: 7,
      flwRefundId: 'RF-123',
      checkedProvider: false,
      reason: REASON,
      requestKey: expect.any(String),
      code: '654321',
    })
  })

  it('leaves the charge to the database when it could not be read here', async () => {
    const { user, dialog } = await checkWith(
      { data: { ok: true, auditId: 3, data: check({ transactionId: '999' }) } },
      { ...refund, providerReference: null },
    )
    expect(await within(dialog).findByText(/matches this refund/)).toBeInTheDocument()
    expect(within(dialog).getByText('Not recorded')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '654321')
    expect(recordButton()).toBeEnabled()
  })

  it('shuts again once the check is 15 minutes old', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { user, dialog } = await checkWith({ data: { ok: true, auditId: 3, data: check() } })
    expect(await within(dialog).findByText(/matches this refund/)).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '654321')
    expect(recordButton()).toBeEnabled()
    act(() => {
      vi.advanceTimersByTime(15 * 60 * 1000 + 15_000)
    })
    await waitFor(() => expect(recordButton()).toBeDisabled())
    expect(
      within(dialog).getByText('This check is over 15 minutes old. Check again.'),
    ).toBeInTheDocument()
  })
})

describe('FlwCheck', () => {
  it('refuses an id that is not one before asking anyone', async () => {
    const user = userEvent.setup()
    render(
      <FlwCheck
        target={{ incidentId: 42 }}
        targetWord="incident"
        check={null}
        problems={[]}
        onCheck={vi.fn()}
        returnTo="/admin/refunds/incidents"
      />,
    )
    const field = screen.getByLabelText('Flutterwave refund id')
    await user.type(field, 'no spaces')
    await user.tab()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText("That isn't a Flutterwave refund id.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check with Flutterwave' })).toBeDisabled()
    expect(checkFlutterwaveRefund).not.toHaveBeenCalled()
  })

  it('says it could not reach the gateway when the call itself fails', async () => {
    vi.mocked(checkFlutterwaveRefund).mockRejectedValue(new Error('fetch failed'))
    const onCheck = vi.fn()
    const user = userEvent.setup()
    render(
      <FlwCheck
        target={{ incidentId: 42 }}
        targetWord="incident"
        check={null}
        problems={[]}
        onCheck={onCheck}
        returnTo="/admin/refunds/incidents"
      />,
    )
    await user.type(screen.getByLabelText('Flutterwave refund id'), 'RF-9')
    await user.click(screen.getByRole('button', { name: 'Check with Flutterwave' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't reach the gateway/)
    expect(checkFlutterwaveRefund).toHaveBeenCalledWith({ flwRefundId: 'RF-9', incidentId: 42 })
    expect(onCheck).toHaveBeenCalledWith(null)
  })

  it('ticks only while asked to', () => {
    function Clock({ active }: { active: boolean }) {
      return <p>{useNow(active, 1_000)}</p>
    }
    vi.useFakeTimers()
    const { rerender } = render(<Clock active={false} />)
    const first = screen.getByText(/\d+/).textContent
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.getByText(/\d+/).textContent).toBe(first)
    rerender(<Clock active />)
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.getByText(/\d+/).textContent).not.toBe(first)
  })
})

describe('ResolveIncident', () => {
  const owed = {
    id: 42,
    kind: 'unrecorded_payment',
    owed: true,
    orderNumber: 'ND-001234',
    providerReference: '456',
    completedRefunds: [
      { id: REFUND, amountKobo: 107_500, completedAt: '2026-10-02T10:00:00Z' },
      { id: '7a1d2c3b-4a59-4687-9a1b-2c3d4e5f6a7b', amountKobo: 50_000, completedAt: null },
    ],
  }

  /** Opens the dialog: the outcome is chosen inside it. */
  async function open(
    incident: typeof owed,
    outcomes: Parameters<typeof ResolveIncident>[0]['outcomes'],
  ) {
    const user = userEvent.setup()
    render(<ResolveIncident incident={incident} outcomes={outcomes} />)
    await user.click(screen.getByRole('button', { name: 'Mark resolved' }))
    const dialog = screen.getByRole('dialog', { name: 'Mark this incident resolved?' })
    return {
      user,
      dialog,
      confirm: () => within(dialog).getByRole('button', { name: 'Mark resolved' }),
    }
  }

  it('records a look, with no code, where nothing is owed', async () => {
    vi.mocked(resolveIncident).mockResolvedValue(ok as never)
    const { user, dialog, confirm } = await open(
      { ...owed, kind: 'tx_ref_mismatch', owed: false, completedRefunds: [] },
      [],
    )
    expect(
      within(dialog).getByText(
        "This records that you've looked at it. Nothing is charged or refunded.",
      ),
    ).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Code from your authenticator app')).toBeNull()
    expect(within(dialog).queryByRole('group', { name: 'What happened?' })).toBeNull()
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.click(confirm())
    expect(resolveIncident).toHaveBeenCalledWith({
      incidentId: 42,
      reason: REASON,
      requestKey: expect.any(String),
    })
  })

  it('asks what happened inside the dialog, and waits for it', async () => {
    const { user, dialog, confirm } = await open(owed, [
      'payment_recorded',
      'refund_completed',
      'flw_refund_verified',
    ])
    expect(within(dialog).getByRole('group', { name: 'What happened?' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('radio', { name: /Handled outside/ })).not.toBeInTheDocument()
    // Each fact is said once: no rows repeat the choice.
    expect(within(dialog).queryByText('Evidence')).toBeNull()
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    expect(confirm()).toBeDisabled()
    expect(within(dialog).getByText('Choose what happened first.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: 'The payment is now recorded' }))
    expect(confirm()).toBeEnabled()
  })

  it('resolves with the completed refund picked', async () => {
    vi.mocked(resolveMoneyIncident).mockResolvedValue(ok as never)
    const { user, dialog, confirm } = await open(owed, [
      'payment_recorded',
      'refund_completed',
      'flw_refund_verified',
    ])
    await user.click(
      within(dialog).getByRole('radio', { name: 'A refund for this order completed' }),
    )
    await user.selectOptions(
      within(dialog).getByLabelText('Which refund'),
      owed.completedRefunds[1]?.id ?? '',
    )
    expect(within(dialog).getByRole('option', { name: '₦500 · —' })).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    await user.click(confirm())
    expect(resolveMoneyIncident).toHaveBeenCalledWith({
      incidentId: 42,
      outcome: 'refund_completed',
      refundId: owed.completedRefunds[1]?.id,
      confirmed: false,
      reason: REASON,
      requestKey: expect.any(String),
      code: '123456',
    })
  })

  it('needs the owner to confirm outside handling', async () => {
    vi.mocked(resolveMoneyIncident).mockResolvedValue(ok as never)
    const { user, dialog, confirm } = await open(
      { ...owed, kind: 'currency_mismatch', completedRefunds: [] },
      ['refund_completed', 'flw_refund_verified', 'handled_outside'],
    )
    expect(
      within(dialog).getByRole('radio', { name: /A refund for this order completed/ }),
    ).toBeDisabled()
    await user.click(within(dialog).getByRole('radio', { name: /Handled outside the dashboard/ }))
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    expect(confirm()).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox', { name: /I confirmed in Flutterwave/ }))
    await user.click(confirm())
    expect(resolveMoneyIncident).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'handled_outside', confirmed: true }),
    )
  })

  it("opens for a Flutterwave refund only when it is on the incident's own charge", async () => {
    vi.mocked(resolveMoneyIncident).mockResolvedValue(ok as never)
    vi.mocked(checkFlutterwaveRefund)
      .mockResolvedValueOnce({
        data: { ok: true, auditId: 1, data: check({ transactionId: '999' }) },
      } as never)
      .mockResolvedValueOnce({
        data: { ok: true, auditId: 2, data: check({ checkId: 8 }) },
      } as never)
    const { user, dialog, confirm } = await open(owed, [
      'payment_recorded',
      'refund_completed',
      'flw_refund_verified',
    ])
    await user.click(
      within(dialog).getByRole('radio', { name: 'A Flutterwave refund I checked just now' }),
    )
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    await user.type(within(dialog).getByLabelText('Flutterwave refund id'), 'RF-123')
    await user.click(within(dialog).getByRole('button', { name: 'Check with Flutterwave' }))
    expect(
      await within(dialog).findByText("It is on charge 999, not this incident's charge 456."),
    ).toBeInTheDocument()
    expect(confirm()).toBeDisabled()

    await user.click(within(dialog).getByRole('button', { name: 'Check with Flutterwave' }))
    expect(await within(dialog).findByText(/matches this incident/)).toBeInTheDocument()
    expect(confirm()).toBeEnabled()
    await user.click(confirm())
    expect(resolveMoneyIncident).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'flw_refund_verified', checkId: 8 }),
    )
    expect(checkFlutterwaveRefund).toHaveBeenCalledWith({ flwRefundId: 'RF-123', incidentId: 42 })
  })
})
