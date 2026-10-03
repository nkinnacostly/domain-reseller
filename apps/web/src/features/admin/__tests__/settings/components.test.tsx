import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setExtensionFlags } from '@/features/admin/actions/extensions'
import {
  checkPresetDraft,
  discardPresetDraft,
  hidePreset,
  publishPresetDraft,
  savePresetDraft,
  showPreset,
} from '@/features/admin/actions/presets'
import { updateLimits } from '@/features/admin/actions/settings'
import { setSslSellable } from '@/features/admin/actions/ssl-products'
import { DraftForm } from '@/features/admin/components/settings/draft-form'
import { ExtensionControls } from '@/features/admin/components/settings/extension-controls'
import { LimitsForm } from '@/features/admin/components/settings/limits-form'
import {
  DraftActions,
  VisibilityActions,
} from '@/features/admin/components/settings/preset-actions'
import {
  RoleNote,
  SettingsPageSkeleton,
} from '@/features/admin/components/settings/settings-header'
import { SslProductAction } from '@/features/admin/components/settings/ssl-product-action'
import type { Limits } from '@/features/admin/lib/settings-limits'

/**
 * The Settings controls in the browser (docs/ADMIN-SPEC.md §5.2 B13): the
 * limits form's bounds and its before → after dialog; the pause dialog that
 * wants the name typed back; featuring at a free rank; the preset draft
 * form; Check now, Publish, Discard, Hide and Show. Each money dialog asks
 * for a reason and the code; what is sent is what the person confirmed.
 */

const refresh = vi.fn()
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/actions/settings', () => ({ updateLimits: vi.fn() }))
vi.mock('@/features/admin/actions/extensions', () => ({ setExtensionFlags: vi.fn() }))
vi.mock('@/features/admin/actions/ssl-products', () => ({ setSslSellable: vi.fn() }))
vi.mock('@/features/admin/actions/presets', () => ({
  savePresetDraft: vi.fn(),
  checkPresetDraft: vi.fn(),
  publishPresetDraft: vi.fn(),
  discardPresetDraft: vi.fn(),
  hidePreset: vi.fn(),
  showPreset: vi.fn(),
}))

const answer = (data: unknown) => ({ data }) as never
const OK = answer({ ok: true, auditId: 1 })
const REASON = 'Checked against the documentation today'
const CODE = '123456'

const LIMITS: Limits = {
  auto_refund_max_kobo: 31_250_050,
  auto_refund_daily_max_kobo: 123_400_000,
  refund_delay_minutes: 17,
  stuck_order_minutes: 23,
  max_domains_per_account_day: 37,
  velocity_new_max: 4,
  velocity_trusted_max: 211,
  velocity_standard_after_days: 9,
  velocity_trusted_after_days: 41,
  velocity_trusted_after_paid_orders: 6,
  float_alert_cents: 4_321,
}

beforeEach(() => vi.clearAllMocks())

async function confirm(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  button: string,
  extra: { reason?: string; code?: boolean; typed?: string } = {},
) {
  if (extra.reason !== undefined) {
    const reason = within(dialog).getAllByRole('textbox')[0] as HTMLElement
    await user.type(reason, extra.reason)
  }
  if (extra.typed) await user.type(within(dialog).getByLabelText(/^Type /), extra.typed)
  if (extra.code) {
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), CODE)
  }
  await user.click(within(dialog).getByRole('button', { name: button }))
}

describe('the limits form', () => {
  it('shows each limit with its bounds, and refuses a value outside them beside the field', async () => {
    const user = userEvent.setup()
    render(<LimitsForm limits={LIMITS} />)
    const single = screen.getByLabelText('Largest refund sent without a person')
    expect(single).toHaveAccessibleDescription(
      'A bigger refund is held until someone approves it. Up to ₦1,000,000.',
    )
    expect(screen.getByRole('status')).toHaveTextContent('Change a value to save it.')
    await user.clear(single)
    await user.type(single, '2000000')
    expect(single).toHaveAttribute('aria-invalid', 'true')
    expect(single).toHaveAccessibleDescription('Enter more than ₦0, up to ₦1,000,000.')
    expect(screen.getByRole('button', { name: 'Review changes' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Fix the values marked above to save.')
    await user.click(screen.getByRole('button', { name: 'Undo changes' }))
    expect(single).toHaveValue('312500.50')
  })

  it('shows every change before → after, says a rise is alerted, and sends only the changes', async () => {
    vi.mocked(updateLimits).mockResolvedValue(OK)
    const user = userEvent.setup()
    render(<LimitsForm limits={LIMITS} />)
    const delay = screen.getByLabelText('Wait before a refund is sent')
    await user.clear(delay)
    await user.type(delay, '12')
    const floatAlert = screen.getByLabelText('Alert when the supplier balance is below')
    await user.clear(floatAlert)
    await user.type(floatAlert, '50')
    expect(screen.getByRole('status')).toHaveTextContent('2 changes ready to review.')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    const dialog = screen.getByRole('dialog', { name: 'Change 2 limits?' })
    expect(dialog).toHaveTextContent('Wait before a refund is sent17 minutes → 12 minutes')
    expect(dialog).toHaveTextContent('$43.21 → $50.00')
    expect(dialog).toHaveTextContent('Raising a refund limit sends a Telegram notice.')
    expect(dialog).not.toHaveTextContent('judged against the new limit')
    await confirm(user, dialog, 'Save limits', { reason: REASON, code: true })
    expect(updateLimits).toHaveBeenCalledWith({
      changes: { refund_delay_minutes: 12, float_alert_cents: 5_000 },
      reason: REASON,
      requestKey: expect.any(String),
      code: CODE,
    })
    expect(await within(dialog).findByText('Limits saved.')).toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
  })

  it('says a fall in a refund limit is judged when the worker picks a refund up, and keeps the daily rule', async () => {
    const user = userEvent.setup()
    render(<LimitsForm limits={LIMITS} />)
    const daily = screen.getByLabelText('Refunds sent without a person, per day')
    await user.clear(daily)
    await user.type(daily, '100000')
    expect(daily).toHaveAccessibleDescription('Make it at least the single limit, ₦312,500.50.')
    await user.clear(daily)
    await user.type(daily, '400000')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    const dialog = screen.getByRole('dialog', { name: 'Change 1 limit?' })
    expect(dialog).toHaveTextContent('judged against the new limit when the worker picks them up')
    expect(dialog).not.toHaveTextContent('Telegram')
  })
})

const AFRICA = {
  name: 'africa',
  isPaused: false,
  pausedReason: null,
  featuredRank: null,
  featuredTagline: null,
}
const RANKS = [
  { name: 'com', rank: 1 },
  { name: 'net', rank: 2 },
]

describe("an extension's controls", () => {
  it('will not pause until the name is typed back, then sends the pause with its reason', async () => {
    vi.mocked(setExtensionFlags).mockResolvedValue(OK)
    const user = userEvent.setup()
    render(
      <ExtensionControls extension={AFRICA} held={12} side="live" ranks={RANKS} returnTo="/x" />,
    )
    await user.click(screen.getByRole('button', { name: 'Pause .africa' }))
    const dialog = screen.getByRole('dialog', { name: 'Pause .africa?' })
    expect(dialog).toHaveTextContent('Held domains (Live side)12')
    expect(dialog).toHaveTextContent('12 domains on the Live side are held on it')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    const pause = within(dialog).getByRole('button', { name: 'Pause' })
    await user.type(
      within(dialog).getByLabelText('Why it is paused'),
      'Registry wants extra details',
    )
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), CODE)
    expect(pause).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type .africa to confirm'), '.africa')
    expect(pause).toBeEnabled()
    await user.click(pause)
    expect(setExtensionFlags).toHaveBeenCalledWith({
      name: 'africa',
      change: { kind: 'pause', why: 'Registry wants extra details' },
      requestKey: expect.any(String),
      code: CODE,
    })
  })

  it('shows a refusal in the dialog, and takes a new request key after it', async () => {
    vi.mocked(setExtensionFlags).mockResolvedValue(
      answer({
        ok: false,
        code: 'REFUSED',
        message: "Your admin role can't do this. Ask the owner.",
      }),
    )
    const user = userEvent.setup()
    render(
      <ExtensionControls extension={AFRICA} held={null} side="test" ranks={RANKS} returnTo="/x" />,
    )
    await user.click(screen.getByRole('button', { name: 'Pause .africa' }))
    const dialog = screen.getByRole('dialog', { name: 'Pause .africa?' })
    expect(dialog).toHaveTextContent('How many domains are held on it could not be read.')
    await confirm(user, dialog, 'Pause', {
      reason: 'e2e: checking the dialog',
      typed: '.africa',
      code: true,
    })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "Your admin role can't do this. Ask the owner.",
    )
    await confirm(user, dialog, 'Pause', { code: true })
    const [first, second] = vi.mocked(setExtensionFlags).mock.calls.map(([input]) => input)
    expect(first?.requestKey).not.toBe(second?.requestKey)
  })

  it('features at the first free rank, refuses a taken one in words, and stops featuring', async () => {
    vi.mocked(setExtensionFlags).mockResolvedValue(OK)
    const user = userEvent.setup()
    const { unmount } = render(
      <ExtensionControls extension={AFRICA} held={0} side="live" ranks={RANKS} returnTo="/x" />,
    )
    const rank = screen.getByLabelText('Rank')
    expect(rank).toHaveValue('3')
    await user.clear(rank)
    await user.type(rank, '1')
    expect(rank).toHaveAccessibleDescription(
      "Rank 1 is .com's. Choose another rank, or move .com first.",
    )
    expect(screen.getByRole('button', { name: 'Feature .africa' })).toBeDisabled()
    await user.clear(rank)
    await user.type(rank, '4')
    await user.type(screen.getByLabelText('Tagline (optional)'), 'For the continent')
    await user.click(screen.getByRole('button', { name: 'Feature .africa' }))
    const dialog = screen.getByRole('dialog', { name: 'Feature .africa?' })
    expect(dialog).toHaveTextContent('Rank4')
    await confirm(user, dialog, 'Save featuring', { reason: REASON, code: true })
    expect(setExtensionFlags).toHaveBeenCalledWith({
      name: 'africa',
      change: { kind: 'feature', rank: 4, tagline: 'For the continent', reason: REASON },
      requestKey: expect.any(String),
      code: CODE,
    })
    unmount()

    render(
      <ExtensionControls
        extension={{ ...AFRICA, featuredRank: 4, featuredTagline: 'For the continent' }}
        held={0}
        side="live"
        ranks={[...RANKS, { name: 'africa', rank: 4 }]}
        returnTo="/x"
      />,
    )
    // Unchanged featuring has nothing to save.
    expect(screen.getByRole('button', { name: 'Save featuring' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Stop featuring .africa' }))
    const stop = screen.getByRole('dialog', { name: 'Stop featuring .africa?' })
    await confirm(user, stop, 'Stop featuring', { reason: REASON, code: true })
    expect(setExtensionFlags).toHaveBeenLastCalledWith(
      expect.objectContaining({ change: { kind: 'unfeature', reason: REASON } }),
    )
  })

  it('resumes a paused extension, showing why it was paused', async () => {
    vi.mocked(setExtensionFlags).mockResolvedValue(OK)
    const user = userEvent.setup()
    render(
      <ExtensionControls
        extension={{ ...AFRICA, isPaused: true, pausedReason: 'Waiting for a source' }}
        held={2}
        side="live"
        ranks={RANKS}
        returnTo="/x"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Resume .africa' }))
    const dialog = screen.getByRole('dialog', { name: 'Resume .africa?' })
    expect(dialog).toHaveTextContent('Paused becauseWaiting for a source')
    await confirm(user, dialog, 'Resume', { reason: REASON, code: true })
    expect(setExtensionFlags).toHaveBeenCalledWith(
      expect.objectContaining({ change: { kind: 'resume', reason: REASON } }),
    )
  })
})

describe('an SSL product', () => {
  it('goes on sale and off sale through a dialog, and says when it has no price', async () => {
    vi.mocked(setSslSellable).mockResolvedValue(OK)
    const user = userEvent.setup()
    const { unmount } = render(
      <SslProductAction productCode="382" name="Sectigo DV SSL" isSellable={false} hasPrice />,
    )
    await user.click(screen.getByRole('button', { name: 'Put on sale Sectigo DV SSL' }))
    const dialog = screen.getByRole('dialog', { name: 'Put Sectigo DV SSL on sale?' })
    await confirm(user, dialog, 'Put on sale', { reason: REASON, code: true })
    expect(setSslSellable).toHaveBeenCalledWith({
      productCode: '382',
      sellable: true,
      reason: REASON,
      requestKey: expect.any(String),
      code: CODE,
    })
    unmount()

    render(<SslProductAction productCode="382" name="Sectigo DV SSL" isSellable hasPrice={false} />)
    await user.click(screen.getByRole('button', { name: 'Take off sale Sectigo DV SSL' }))
    await confirm(user, screen.getByRole('dialog'), 'Take off sale', {
      reason: REASON,
      code: true,
    })
    expect(setSslSellable).toHaveBeenLastCalledWith(expect.objectContaining({ sellable: false }))
  })

  it('offers no button for a product with no price that is off sale', () => {
    render(
      <SslProductAction productCode="999" name="Unpriced" isSellable={false} hasPrice={false} />,
    )
    expect(
      screen.getByText('DomainNameAPI lists no price for this product yet.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

const START = {
  presetId: 'd97320b5-50a9-44d4-a881-7b4bc1a5e077',
  provider: 'Example Host',
  nameservers: ['ns1.example-host.test', 'ns2.example-host.test'],
  sourceUrl: 'https://docs.example-host.test/nameservers',
  notes: null,
  assignsPerZone: false,
}

describe('the preset draft form', () => {
  it('has nothing to save until something changes, and checks hosts as typed', async () => {
    const user = userEvent.setup()
    render(<DraftForm start={START} returnTo="/x" />)
    const save = screen.getByRole('button', { name: 'Save draft' })
    expect(save).toBeDisabled()
    expect(screen.getByText('Change something to save a draft.')).toBeInTheDocument()
    const hosts = screen.getByLabelText('Nameservers')
    await user.clear(hosts)
    await user.type(hosts, 'ns3.example-host.test')
    await user.tab()
    expect(hosts).toHaveAccessibleDescription('Give 2 to 13 nameservers, one per line.')
    expect(save).toBeDisabled()
  })

  it('saves the typed hosts, lower-cased, with the source, after the dialog', async () => {
    vi.mocked(savePresetDraft).mockResolvedValue(OK)
    const user = userEvent.setup()
    render(<DraftForm start={START} returnTo="/x" />)
    const hosts = screen.getByLabelText('Nameservers')
    await user.clear(hosts)
    await user.type(hosts, 'NS3.Example-Host.test{enter}ns4.example-host.test')
    await user.type(screen.getByLabelText('Notes (optional)'), 'Moved in October')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    const dialog = screen.getByRole('dialog', {
      name: "Save a draft of Example Host's nameservers?",
    })
    expect(dialog).toHaveTextContent('Nowns1.example-host.test, ns2.example-host.test')
    expect(dialog).toHaveTextContent('Draftns3.example-host.test, ns4.example-host.test')
    await confirm(user, dialog, 'Save draft', { reason: REASON, code: true })
    expect(savePresetDraft).toHaveBeenCalledWith({
      presetId: START.presetId,
      nameservers: ['ns3.example-host.test', 'ns4.example-host.test'],
      sourceUrl: START.sourceUrl,
      notes: 'Moved in October',
      assignsPerZone: false,
      reason: REASON,
      requestKey: expect.any(String),
      code: CODE,
    })
    expect(push).not.toHaveBeenCalled()
  })

  it("saves a new host by name and opens its draft's page", async () => {
    vi.mocked(savePresetDraft).mockResolvedValue(
      answer({ ok: true, auditId: 3, after: { draft_id: '6e1f0a9c-1111-4222-8333-444455556666' } }),
    )
    const user = userEvent.setup()
    render(
      <DraftForm
        start={{ ...START, presetId: null, provider: '', nameservers: [], sourceUrl: '' }}
        returnTo="/x"
      />,
    )
    await user.type(screen.getByLabelText('Provider'), 'New Host')
    await user.click(
      screen.getByRole('checkbox', { name: /gives each domain its own nameservers/ }),
    )
    const source = screen.getByLabelText("Source: the provider's own page")
    await user.type(source, 'http://docs.new-host.test')
    await user.tab()
    expect(source).toHaveAttribute('aria-invalid', 'true')
    await user.clear(source)
    await user.type(source, 'https://docs.new-host.test/dns')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    const dialog = screen.getByRole('dialog', { name: "Save a draft of New Host's nameservers?" })
    expect(dialog).toHaveTextContent('NowNot offered yet')
    expect(dialog).toHaveTextContent('DraftPer domain')
    await confirm(user, dialog, 'Save draft', { reason: REASON, code: true })
    expect(savePresetDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: null,
        provider: 'New Host',
        nameservers: [],
        assignsPerZone: true,
      }),
    )
    expect(push).toHaveBeenCalledWith(
      '/admin/settings/presets/6e1f0a9c-1111-4222-8333-444455556666',
    )
  })
})

const DRAFT = {
  id: '5e1f0a9c-1111-4222-8333-444455556666',
  provider: 'Example Host',
  nameservers: ['ns3.example-host.test', 'ns4.example-host.test'],
}

describe("a draft's buttons", () => {
  it('checks now and says what the gateway found, then refreshes the page', async () => {
    vi.mocked(checkPresetDraft).mockResolvedValueOnce(
      answer({
        ok: true,
        auditId: 9,
        data: {
          ok: true,
          hosts: [
            { host: 'ns3.example-host.test', ok: true },
            { host: 'ns4.example-host.test', ok: true },
          ],
          checkedAt: '2026-10-03T13:05:00Z',
        },
      }),
    )
    vi.mocked(checkPresetDraft).mockResolvedValueOnce(
      answer({ ok: false, code: 'TOO_SOON', message: 'This was read moments ago.' }),
    )
    vi.mocked(checkPresetDraft).mockRejectedValueOnce(new Error('network'))
    const user = userEvent.setup()
    render(
      <DraftActions
        draft={DRAFT}
        before={['ns1.example-host.test']}
        publishable={false}
        checkable
        lastCheck="Not checked yet."
        returnTo="/x"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Checked at 14:05 WAT: both hosts answer.',
    )
    expect(checkPresetDraft).toHaveBeenCalledWith({ draftId: DRAFT.id })
    expect(refresh).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This was read moments ago.')
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't reach")
  })

  it('says a failed check as one', async () => {
    vi.mocked(checkPresetDraft).mockResolvedValue(
      answer({
        ok: true,
        auditId: 9,
        data: {
          ok: false,
          hosts: [{ host: 'ns4.example-host.test', ok: false }],
          checkedAt: '2026-10-03T13:05:00Z',
        },
      }),
    )
    const user = userEvent.setup()
    render(
      <DraftActions
        draft={DRAFT}
        before={null}
        publishable={false}
        checkable
        lastCheck="—"
        returnTo="/x"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "ns4.example-host.test didn't answer.",
    )
  })

  it('publishes only once publishable, showing before → after and the last check', async () => {
    vi.mocked(publishPresetDraft).mockResolvedValue(OK)
    const user = userEvent.setup()
    const { rerender } = render(
      <DraftActions
        draft={DRAFT}
        before={['ns1.example-host.test', 'ns2.example-host.test']}
        publishable={false}
        checkable={false}
        lastCheck="Not checked yet."
        returnTo="/x"
      />,
    )
    expect(screen.getByRole('button', { name: "Publish Example Host's draft" })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull()
    expect(
      screen.getByText('Publish opens once a check passes after the draft was saved.'),
    ).toBeInTheDocument()
    rerender(
      <DraftActions
        draft={DRAFT}
        before={['ns1.example-host.test', 'ns2.example-host.test']}
        publishable
        checkable
        lastCheck="Checked 3 Oct 2026, 14:05 WAT: both hosts answer."
        returnTo="/x"
      />,
    )
    await user.click(screen.getByRole('button', { name: "Publish Example Host's draft" }))
    const dialog = screen.getByRole('dialog', { name: "Publish Example Host's new nameservers?" })
    expect(dialog).toHaveTextContent('Beforens1.example-host.test, ns2.example-host.test')
    expect(dialog).toHaveTextContent('Afterns3.example-host.test, ns4.example-host.test')
    expect(dialog).toHaveTextContent('Last checkChecked 3 Oct 2026, 14:05 WAT: both hosts answer.')
    await confirm(user, dialog, 'Publish', { reason: REASON, code: true })
    expect(publishPresetDraft).toHaveBeenCalledWith({
      draftId: DRAFT.id,
      reason: REASON,
      requestKey: expect.any(String),
      code: CODE,
    })
  })

  it('discards with an optional reason and no code', async () => {
    vi.mocked(discardPresetDraft).mockResolvedValue(OK)
    const user = userEvent.setup()
    render(
      <DraftActions
        draft={DRAFT}
        before={null}
        publishable={false}
        checkable={false}
        lastCheck="—"
        returnTo="/x"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Discard draft' }))
    const dialog = screen.getByRole('dialog', {
      name: "Discard the draft of Example Host's nameservers?",
    })
    expect(within(dialog).queryByLabelText('Code from your authenticator app')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Discard draft' }))
    expect(discardPresetDraft).toHaveBeenCalledWith({
      draftId: DRAFT.id,
      requestKey: expect.any(String),
    })
  })
})

describe('hiding and showing a preset', () => {
  const preset = { id: 'd97320b5-50a9-44d4-a881-7b4bc1a5e077', provider: 'Example Host' }

  it('hides with the domains on it said, no code', async () => {
    vi.mocked(hidePreset).mockResolvedValue(OK)
    const user = userEvent.setup()
    render(
      <VisibilityActions
        preset={{ ...preset, isHidden: false }}
        domains={3}
        side="live"
        returnTo="/x"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Hide Example Host' }))
    const dialog = screen.getByRole('dialog', { name: 'Hide Example Host?' })
    expect(dialog).toHaveTextContent(
      '3 domains use it now on the Live side; they keep their nameservers.',
    )
    await confirm(user, dialog, 'Hide', { reason: 'Provider is retiring these' })
    expect(hidePreset).toHaveBeenCalledWith({
      presetId: preset.id,
      requestKey: expect.any(String),
      reason: 'Provider is retiring these',
    })
  })

  it('shows again with a reason and the code', async () => {
    vi.mocked(showPreset).mockResolvedValue(OK)
    const user = userEvent.setup()
    render(
      <VisibilityActions
        preset={{ ...preset, isHidden: true }}
        domains={null}
        side="live"
        returnTo="/x"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Show Example Host again' }))
    const dialog = screen.getByRole('dialog', { name: 'Show Example Host again?' })
    await confirm(user, dialog, 'Show again', { reason: REASON, code: true })
    expect(showPreset).toHaveBeenCalledWith({
      presetId: preset.id,
      reason: REASON,
      requestKey: expect.any(String),
      code: CODE,
    })
  })
})

describe('the shared pieces', () => {
  it('says nothing when everyone may act, and draws a skeleton while loading', () => {
    const { container } = render(<RoleNote words={null} />)
    expect(container).toBeEmptyDOMElement()
    const skeleton = render(<SettingsPageSkeleton cards={2} />)
    expect(skeleton.container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3)
  })
})
