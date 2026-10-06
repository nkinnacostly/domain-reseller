import { describe, expect, it } from 'vitest'
import { describeAction, describeActor, readAuditRows } from '../lib/audit'
import { pickAccount, readMemberships } from '../lib/current'
import { hashInviteToken, inviteLink, isInviteToken, newInviteToken } from '../lib/invite-token'
import { memberName } from '../lib/people'
import { asAnswer, RESULT_FALLBACK, resultMessage } from '../lib/results'
import {
  canEditProfile,
  canLeave,
  canManage,
  canManageMembers,
  canTransfer,
  grantableBy,
  isGrantableRole,
} from '../lib/roles'
import { accountBanner, isAccountState } from '../lib/state'
import { isProfileComplete, nextSteps } from '../lib/steps'
import { formatCount, meter, readUsage } from '../lib/usage'

describe('roles (MAIL-SPEC §9; migration 46)', () => {
  it('lets the owner manage admins, and admins only developers and viewers', () => {
    expect(grantableBy('owner')).toEqual(['admin', 'developer', 'viewer'])
    expect(grantableBy('admin')).toEqual(['developer', 'viewer'])
    expect(grantableBy('developer')).toEqual([])
    expect(canManage('owner', 'admin', false)).toBe(true)
    expect(canManage('admin', 'admin', false)).toBe(false)
    expect(canManage('admin', 'viewer', false)).toBe(true)
    expect(canManage('viewer', 'viewer', false)).toBe(false)
  })

  it('never offers to change the owner, or oneself', () => {
    expect(canManage('owner', 'owner', false)).toBe(false)
    expect(canManage('owner', 'admin', true)).toBe(false)
  })

  it('keeps the profile, members and log for owners and admins; leaving for all but the owner', () => {
    expect([canEditProfile('admin'), canEditProfile('developer')]).toEqual([true, false])
    expect([canManageMembers('owner'), canManageMembers('viewer')]).toEqual([true, false])
    expect([canLeave('owner'), canLeave('viewer')]).toEqual([false, true])
    expect([canTransfer('owner'), canTransfer('admin')]).toEqual([true, false])
    expect([isGrantableRole('viewer'), isGrantableRole('owner'), isGrantableRole(1)]).toEqual([
      true,
      false,
      false,
    ])
  })
})

describe('accountBanner (§7.2, §8, MR5)', () => {
  const base = { state: 'active' as const, sesStatus: 'enabled' }

  it('says nothing for an active account in good standing', () => {
    expect(accountBanner(base, null, null)).toBeNull()
  })

  it('explains the sandbox with SQL’s cap, and what lets the account out', () => {
    const banner = accountBanner({ ...base, state: 'sandbox' }, null, 100)
    expect(banner).toMatchObject({ kind: 'sandbox', tone: 'info' })
    expect(banner?.body).toContain('up to 100 a day')
    expect(banner?.body).toContain('a domain is verified, the profile is complete')
    expect(accountBanner({ ...base, state: 'sandbox' }, null, null)?.body).toContain(
      'a small daily cap',
    )
  })

  it('puts a pause first, ours or SES’s, over the sandbox and a failed payment', () => {
    const until = new Date('2026-10-13T12:00:00Z')
    expect(accountBanner({ state: 'paused', sesStatus: 'enabled' }, null, 100)?.kind).toBe('paused')
    expect(
      accountBanner({ state: 'sandbox', sesStatus: 'disabled' }, { status: 'past_due', until }, 1)
        ?.kind,
    ).toBe('paused')
  })

  it('words seven days past due, by the date sending stops', () => {
    const banner = accountBanner(
      base,
      { status: 'past_due', until: new Date('2026-10-13T12:00:00Z') },
      null,
    )
    expect(banner).toMatchObject({ kind: 'past_due', tone: 'warning' })
    expect(banner?.body).toContain('Sending continues until 13 October')
  })

  it('says a closed account is closed', () => {
    expect(accountBanner({ ...base, state: 'closed' }, null, null)?.kind).toBe('closed')
    expect([isAccountState('sandbox'), isAccountState('gone')]).toEqual([true, false])
  })
})

describe('usage (§8: caps count recipients)', () => {
  it('measures a cap, warns at 80% and says when it is reached', () => {
    expect(meter(10, 100)).toEqual({ used: 10, cap: 100, percent: 10, level: 'ok' })
    expect(meter(80, 100).level).toBe('warning')
    expect(meter(150, 100)).toMatchObject({ percent: 100, level: 'reached' })
    expect(meter(0, 0)).toMatchObject({ percent: 100, level: 'reached' })
    expect(meter(-3.7, 10.9)).toMatchObject({ used: 0, cap: 10 })
    expect(formatCount(150000)).toBe('150,000')
  })

  const counts = { queued: 7, sent: 6, delivered: 5, bounced: 1, complained: 0, failed: 0 }
  const answer = {
    ok: true,
    day: '2026-10-06',
    monthStart: '2026-10-01',
    planCode: 'free',
    caps: { daily: 100, monthly: 3000 },
    today: counts,
    month: counts,
  }

  it('reads account_usage’s answer', () => {
    expect(readUsage(answer)).toEqual({
      day: '2026-10-06',
      monthStart: '2026-10-01',
      planCode: 'free',
      caps: { daily: 100, monthly: 3000 },
      today: counts,
      month: counts,
    })
  })

  it.each([
    ['nothing', null],
    ['a refusal', { ok: false, code: 'not_found' }],
    ['no caps', { ...answer, caps: undefined }],
    ['a count that is not a number', { ...answer, today: { ...counts, sent: 'x' } }],
    ['a negative count', { ...answer, month: { ...counts, failed: -1 } }],
    ['no day', { ...answer, day: 5 }],
    ['counts that are not an object', { ...answer, today: 3 }],
  ])('refuses %s rather than guess', (_case, value) => {
    expect(readUsage(value)).toBeNull()
  })
})

describe('next steps (§7.2, §10)', () => {
  const profile = {
    name: 'Acme',
    website: 'https://acme.example',
    useCase: 'Receipts',
    expectedMonthlyVolume: 0,
  }

  it('counts a profile complete only with all four answers', () => {
    expect(isProfileComplete(profile)).toBe(true)
    expect(isProfileComplete({ ...profile, website: ' ' })).toBe(false)
    expect(isProfileComplete({ ...profile, useCase: null })).toBe(false)
    expect(isProfileComplete({ ...profile, expectedMonthlyVolume: null })).toBe(false)
  })

  it('lists the domain, the profile, the review in the sandbox, then a key', () => {
    const steps = nextSteps({
      state: 'sandbox',
      role: 'owner',
      verifiedDomains: 0,
      activeKeys: 2,
      profileComplete: true,
    })
    expect(steps.map((step) => [step.id, step.done])).toEqual([
      ['domain', false],
      ['profile', true],
      ['review', false],
      ['key', true],
    ])
  })

  it('drops the review once approved, and never guesses keys a viewer cannot see', () => {
    const steps = nextSteps({
      state: 'active',
      role: 'viewer',
      verifiedDomains: 1,
      activeKeys: null,
      profileComplete: false,
    })
    expect(steps.map((step) => [step.id, step.done])).toEqual([
      ['domain', true],
      ['profile', false],
      ['key', null],
    ])
  })
})

describe('invite tokens (§9: a hash of the token)', () => {
  it('makes a fresh 256-bit token and keeps only its SHA-256', () => {
    const a = newInviteToken()
    const b = newInviteToken()
    expect(isInviteToken(a.token)).toBe(true)
    expect(a.token).not.toBe(b.token)
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.hash).toBe(hashInviteToken(a.token))
    expect(hashInviteToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('looks up only what could be a token, and links to the invite page', () => {
    expect([
      isInviteToken('short'),
      isInviteToken(42),
      isInviteToken(`${'a'.repeat(42)}!`),
    ]).toEqual([false, false, false])
    expect(inviteLink('https://emails.mydomainshub.com', 'tok')).toBe(
      'https://emails.mydomainshub.com/invite?token=tok',
    )
  })
})

describe('resultMessage', () => {
  it('words every refusal with a next step, and the seats and limits by number', () => {
    expect(resultMessage({ code: 'member_limit', max: 1 })).toMatch(/has 1 member seat,/)
    expect(resultMessage({ code: 'member_limit', max: 3 })).toMatch(/has 3 member seats,/)
    expect(resultMessage({ code: 'limit', max: 3 })).toMatch(/already own 3 open Mail accounts/)
    expect(resultMessage({ code: 'limit' })).toMatch(/already own the most/)
    expect(resultMessage({ code: 'wrong_email' })).toMatch(/different email address/)
    expect(resultMessage({ code: 'something_new' })).toBe(RESULT_FALLBACK)
    expect(resultMessage(null)).toBe(RESULT_FALLBACK)
  })

  it('reads only objects as answers', () => {
    expect(asAnswer({ ok: true })).toEqual({ ok: true })
    expect([asAnswer([]), asAnswer('x'), asAnswer(null)]).toEqual([null, null, null])
  })
})

describe('the account log in words (§9)', () => {
  const names = new Map([
    ['u-ada', 'Ada Owner'],
    ['u-bola', 'Bola'],
  ])
  const row = (
    action: string,
    detail: Record<string, unknown> = {},
    target: string | null = null,
  ) => ({
    id: 1,
    at: '2026-10-06T10:00:00Z',
    actor: 'user',
    actorUserId: 'u-ada',
    action,
    target,
    detail,
  })

  it('names members, and nobody else', () => {
    expect(describeActor(row('account.created'), names)).toBe('Ada Owner')
    expect(describeActor({ ...row('x'), actorUserId: 'u-gone' }, names)).toBe('a former member')
    expect(describeActor({ ...row('x'), actorUserId: null }, names)).toBe('someone')
    expect(describeActor({ ...row('x'), actor: 'system' }, names)).toBe('MyDomainsHub Mail')
    expect(describeActor({ ...row('x'), actor: 'admin' }, names)).toBe('MyDomainsHub support')
    expect(describeActor({ ...row('x'), actor: 'api' }, names)).toBe('An API key')
  })

  it.each([
    [row('account.created'), 'created the account'],
    [
      row('account.updated', { fields: ['website', 'use_case'] }),
      'changed the account’s website, what it sends',
    ],
    [row('account.updated'), 'changed the account profile'],
    [row('account.ownership_transferred', {}, 'u-bola'), 'handed the account over to Bola'],
    [
      { ...row('member.added', { role: 'developer' }, 'u-bola'), actorUserId: 'u-bola' },
      'joined as developer',
    ],
    [row('member.added', { role: 'viewer' }, 'u-bola'), 'added Bola as viewer'],
    [row('member.removed', { role: 'viewer' }), 'removed a viewer'],
    [row('member.left', { role: 'admin' }), 'left the account (was admin)'],
    [
      row('member.role_changed', { from: 'developer', to: 'viewer' }, 'u-bola'),
      'changed Bola from developer to viewer',
    ],
    [row('invite.created', { role: 'developer' }), 'invited someone as developer'],
    [row('invite.revoked', { role: 'admin' }), 'revoked an invite (admin)'],
    [row('invite.accepted', { role: 'nonsense' }), 'accepted an invite as member'],
    [row('key.created', { prefix: 'mdh_live_ab12' }), 'created API key mdh_live_ab12…'],
    [row('key.revoked'), 'revoked API key'],
    [row('domain.removed'), 'removed a domain'],
    [row('webhook.secret_rotated'), 'webhook secret rotated'],
  ])('%#: says what happened', (entry, words) => {
    expect(describeAction(entry, names)).toBe(words)
  })

  it('reads rows as PostgREST returns them, dropping what it cannot read', () => {
    expect(
      readAuditRows([
        {
          id: 3,
          at: '2026-10-06T10:00:00Z',
          actor: 'user',
          actor_user_id: 'u-ada',
          action: 'account.created',
          target: 'a',
          detail: {},
        },
        { id: 4, at: '2026-10-06T10:00:00Z', action: 'x.y', detail: [] },
        { id: 5, action: 'no.time' },
        null,
      ]),
    ).toEqual([
      {
        id: 3,
        at: '2026-10-06T10:00:00Z',
        actor: 'user',
        actorUserId: 'u-ada',
        action: 'account.created',
        target: 'a',
        detail: {},
      },
      {
        id: 4,
        at: '2026-10-06T10:00:00Z',
        actor: 'user',
        actorUserId: null,
        action: 'x.y',
        target: null,
        detail: {},
      },
    ])
    expect(readAuditRows(null)).toEqual([])
  })
})

describe('memberships and the current account (§10: the switcher)', () => {
  const account = (id: string, state = 'sandbox') => ({
    id,
    name: `Account ${id}`,
    state,
    ses_status: 'pending',
    state_reason: null as string | null,
    plan_code: 'free',
    website: null,
    use_case: 'Receipts',
    expected_monthly_volume: 100,
    created_at: '2026-10-06T10:00:00Z',
  })

  it('reads members with their accounts, dropping rows it cannot trust', () => {
    const memberships = readMemberships([
      { role: 'owner', accounts: account('a') },
      { role: 'boss', accounts: account('b') },
      { role: 'viewer', accounts: null },
      { role: 'viewer', accounts: account('c', 'weird') },
    ])
    expect(memberships).toEqual([
      {
        role: 'owner',
        account: {
          id: 'a',
          name: 'Account a',
          state: 'sandbox',
          sesStatus: 'pending',
          stateReason: null,
          planCode: 'free',
          website: null,
          useCase: 'Receipts',
          expectedMonthlyVolume: 100,
          createdAt: '2026-10-06T10:00:00Z',
        },
      },
    ])
    expect(readMemberships('nope')).toEqual([])
    // Migration 51: why a paused or closed account is so, as a code the banner words.
    const paused = readMemberships([
      { role: 'owner', accounts: { ...account('p', 'paused'), state_reason: 'paused_by_admin' } },
    ])
    expect(paused[0]?.account.stateReason).toBe('paused_by_admin')
  })

  it('shows the remembered account while the person is its member, else the first open one', () => {
    const memberships = readMemberships([
      { role: 'owner', accounts: account('closed', 'closed') },
      { role: 'admin', accounts: account('open') },
    ])
    expect(pickAccount(memberships, 'open')?.account.id).toBe('open')
    expect(pickAccount(memberships, 'someone-elses')?.account.id).toBe('open')
    expect(pickAccount(memberships.slice(0, 1), null)?.account.id).toBe('closed')
    expect(pickAccount([], 'x')).toBeNull()
  })

  it('names a member by name, else address', () => {
    expect(memberName({ name: 'Ada', email: 'a@example.com' })).toBe('Ada')
    expect(memberName({ name: null, email: 'a@example.com' })).toBe('a@example.com')
    expect(memberName({ name: null, email: null })).toBe('A member')
  })
})
