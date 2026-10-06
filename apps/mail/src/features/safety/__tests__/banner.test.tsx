import { render, screen } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { StateBanner } from '@/features/accounts/components/state-banner'
import { accountBanner } from '@/features/accounts/lib/state'
import { server } from '../../../../tests/mocks/server'

/**
 * The dashboard's banner for what migration 51 records (MAIL-SPEC §8, §7.4,
 * MR5): a pause's reason and a rejection in words — never an admin's own,
 * never a limit written in code (N5b) — and 80% and 100% of a cap.
 */

vi.mock('@/lib/supabase/server', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  return {
    createClient: async () =>
      createClient('http://127.0.0.1:54321', 'test-publishable-key', { db: { schema: 'mail' } }),
  }
})

const base = { state: 'active' as const, sesStatus: 'enabled' }

describe('why sending stopped', () => {
  it.each([
    ['paused_bounce_rate', 'Too many of this account’s recent emails bounced'],
    ['paused_complaint_rate', 'reported this account’s recent emails as spam'],
    ['paused_by_admin', 'Our team paused sending on this account.'],
  ])('%s', (reason, words) => {
    const banner = accountBanner({ ...base, state: 'paused', stateReason: reason }, null, null)
    expect(banner?.kind).toBe('paused')
    expect(banner?.body).toContain(words)
    expect(banner?.body).toContain('hello@mydomainshub.com')
    expect(banner?.body).not.toMatch(/\d+(\.\d+)?%/)
  })

  it('keeps the plain words for a pause it has no reason for, and for SES’s own', () => {
    expect(
      accountBanner({ ...base, state: 'paused', stateReason: 'something_new' }, null, null)?.body,
    ).toMatch(/^While it is paused/)
    expect(
      accountBanner({ ...base, sesStatus: 'disabled', stateReason: 'paused_by_admin' }, null, null)
        ?.body,
    ).toMatch(/^While it is paused/)
  })

  it('says an account was not approved, and the plain words for any other closing', () => {
    expect(
      accountBanner({ ...base, state: 'closed', stateReason: 'rejected_at_review' }, null, null)
        ?.body,
    ).toContain('did not approve')
    expect(accountBanner({ ...base, state: 'closed' }, null, null)?.body).toMatch(
      /^Nothing can be sent/,
    )
  })
})

describe('80% and 100% of a cap (§8)', () => {
  it('warns at 80% and stops at 100%, with when it resets, ahead of the sandbox', () => {
    const warning = accountBanner(base, null, null, {
      scope: 'day',
      level: 80,
      cap: 5000,
      used: 4100,
    })
    expect(warning).toMatchObject({
      kind: 'cap',
      tone: 'warning',
      title: '80% of the cap for today is used',
    })
    expect(warning?.body).toContain('4,100 of 5,000 emails for today')
    expect(warning?.body).toContain('midnight, Lagos time')
    const reached = accountBanner({ ...base, state: 'sandbox' }, null, 100, {
      scope: 'month',
      level: 100,
      cap: 3000,
      used: 3000,
    })
    expect(reached).toMatchObject({
      kind: 'cap',
      tone: 'danger',
      title: 'The cap for this month is reached',
    })
    expect(reached?.body).toContain('quota_exceeded')
    expect(reached?.body).toContain('1st of next month')
  })

  it('gives way to a pause and a failed payment', () => {
    const notice = { scope: 'day' as const, level: 100 as const, cap: 10, used: 10 }
    expect(accountBanner({ ...base, state: 'paused' }, null, null, notice)?.kind).toBe('paused')
    expect(
      accountBanner(base, { status: 'past_due', until: new Date('2026-10-13') }, null, notice)
        ?.kind,
    ).toBe('past_due')
  })

  it('draws the cap banner with its icon, words and the way to the usage', () => {
    render(
      <StateBanner
        banner={accountBanner(base, null, null, { scope: 'day', level: 80, cap: 100, used: 85 })}
      />,
    )
    const banner = screen.getByRole('region', { name: 'Account status' })
    expect(banner).toHaveAttribute('data-banner', 'cap')
    expect(screen.getByRole('link', { name: 'See the usage' })).toHaveAttribute(
      'href',
      '/dashboard#usage-heading',
    )
  })
})

describe('reading the notice (RLS: members only)', () => {
  it('asks cap_notices for this day and month, and shows nothing when it cannot read', async () => {
    const { getCapNotice } = await import('../queries/cap-notices')
    let asked = ''
    server.use(
      http.get('http://127.0.0.1:54321/rest/v1/cap_notices', ({ request }) => {
        asked = new URL(request.url).search
        return HttpResponse.json([
          { scope: 'day', period_start: '2026-10-06', level: 80, cap: 100, used: 82 },
          { scope: 'month', period_start: '2026-10-01', level: 100, cap: 3000, used: 3000 },
        ])
      }),
    )
    const period = { day: '2026-10-06', monthStart: '2026-10-01' }
    expect(await getCapNotice('0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e', period)).toEqual({
      scope: 'month',
      level: 100,
      cap: 3000,
      used: 3000,
    })
    expect(decodeURIComponent(asked)).toContain('period_start=in.(2026-10-06,2026-10-01)')
    server.use(
      http.get('http://127.0.0.1:54321/rest/v1/cap_notices', () =>
        HttpResponse.json({ code: '42501', message: 'denied' }, { status: 403 }),
      ),
    )
    expect(await getCapNotice('0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e', period)).toBeNull()
  })
})
