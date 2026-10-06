import { describe, expect, it } from 'vitest'
import {
  type AuthEmailPayload,
  authEmailPayloadSchema,
  mailOrigin,
  planAuthEmail,
} from '../lib/auth-email'

const APP = 'https://www.mydomainshub.com'

const payload = (
  type: string,
  data: Record<string, string> = {},
  user: Record<string, unknown> = {},
): AuthEmailPayload =>
  authEmailPayloadSchema.parse({
    user: { email: 'ada@example.com', ...user },
    email_data: { email_action_type: type, token_hash: 'hash-1', token: '123456', ...data },
  })

const sent = (plan: ReturnType<typeof planAuthEmail>) => {
  if (plan.kind !== 'send') throw new Error(`expected emails, got ${plan.kind}`)
  return plan.emails
}

const linkIn = (html: string) => {
  const match = html.match(/href="([^"]+)"/)
  return new URL((match?.[1] ?? '').replaceAll('&amp;', '&'))
}

describe('planAuthEmail (L1, L2)', () => {
  it('confirms a sign-up with a token-hash link to our own /auth/confirm', () => {
    const [email] = sent(
      planAuthEmail(payload('signup', { redirect_to: `${APP}/app/domains` }), APP),
    )
    expect(email).toMatchObject({
      to: 'ada@example.com',
      subject: 'Confirm your email',
      tags: ['auth', 'signup'],
    })
    const link = linkIn(email?.html ?? '')
    expect(link.origin + link.pathname).toBe(`${APP}/auth/confirm`)
    expect(Object.fromEntries(link.searchParams)).toEqual({
      token_hash: 'hash-1',
      type: 'email',
      next: `${APP}/app/domains`,
    })
    expect(email?.text).toContain('Confirm my email: https://www.mydomainshub.com/auth/confirm?')
  })

  it('sends a sign-in link for magic link and email OTP, to the dashboard by default', () => {
    for (const type of ['magiclink', 'email']) {
      const [email] = sent(planAuthEmail(payload(type), APP))
      expect(email?.subject).toBe('Your sign-in link')
      expect(linkIn(email?.html ?? '').searchParams.get('next')).toBe('/app/domains')
    }
  })

  it('sends a reset link that lands on the new-password page, and says about the 24-hour hold', () => {
    const [email] = sent(
      planAuthEmail(payload('recovery', { redirect_to: 'https://evil.test' }), APP),
    )
    expect(email?.subject).toBe('Reset your password')
    const link = linkIn(email?.html ?? '')
    expect(link.searchParams.get('type')).toBe('recovery')
    expect(link.searchParams.get('next')).toBe('/reset-password')
    expect(email?.text).toMatch(/paused for 24 hours/)
  })

  it('confirms an email change with both addresses, hashes the way Supabase names them', () => {
    const emails = sent(
      planAuthEmail(
        payload(
          'email_change',
          { token_hash: 'for-new', token_hash_new: 'for-current' },
          {
            new_email: 'ada.new@example.com',
          },
        ),
        APP,
      ),
    )
    expect(emails.map((email) => email.to)).toEqual(['ada.new@example.com', 'ada@example.com'])
    expect(linkIn(emails[0]?.html ?? '').searchParams.get('token_hash')).toBe('for-new')
    expect(linkIn(emails[1]?.html ?? '').searchParams.get('token_hash')).toBe('for-current')
    expect(emails[1]?.text).toContain(
      'change the email address on your account to ada.new@example.com',
    )
  })

  it('sends one email to the new address when the change needs only that', () => {
    const emails = sent(
      planAuthEmail(payload('email_change', {}, { new_email: 'ada.new@example.com' }), APP),
    )
    expect(emails.map((email) => email.to)).toEqual(['ada.new@example.com'])
  })

  it('sends a verification code, not a link, to re-authenticate', () => {
    const [email] = sent(planAuthEmail(payload('reauthentication'), APP))
    expect(email?.subject).toBe('Your verification code')
    expect(email?.html).toContain('123456')
    expect(email?.html).not.toContain('href="https://www.mydomainshub.com')
    expect(email?.text).toContain('Your code: 123456')
  })

  it('heads every email with the brand mark and name, readable with images blocked', () => {
    const [email] = sent(planAuthEmail(payload('signup'), APP))
    expect(email?.html).toContain(
      'src="https://www.mydomainshub.com/brand/mydomainshub-mark-96.png" width="32" height="32" alt=""',
    )
    expect(email?.html).toMatch(/alt=""[^>]*>MyDomainsHub</)
    expect(email?.html).toContain('background:#155dfc')
    expect(email?.text.startsWith('MyDomainsHub\n')).toBe(true)
  })

  it('invites replies to the support inbox in every email', () => {
    const [email] = sent(planAuthEmail(payload('signup'), APP))
    expect(email?.text).toContain('Reply to this email, or write to hello@mydomainshub.com.')
  })

  it('escapes what it prints, so an address cannot inject markup', () => {
    const emails = sent(
      planAuthEmail(
        payload('email_change', { token_hash_new: 'x' }, { new_email: "o'brien@example.com" }),
        APP,
      ),
    )
    expect(emails[0]?.html).toContain('o&#39;brien@example.com')
    expect(emails[0]?.html).not.toContain("o'brien@example.com")
  })

  it.each([
    ['signup', { token_hash: '' }, {}],
    ['magiclink', { token_hash: '' }, {}],
    ['recovery', { token_hash: '' }, {}],
    ['email_change', {}, {}],
    ['email_change', { token_hash: '', token_hash_new: '' }, { new_email: 'b@example.com' }],
    ['reauthentication', { token: '' }, {}],
    ['invite', {}, {}],
    ['password_changed_notification', {}, {}],
  ])(
    'sends nothing for %s without what it needs, or an action we do not use',
    (type, data, user) => {
      expect(planAuthEmail(payload(type, data, user), APP).kind).toBe('skip')
    },
  )

  it('refuses a payload without an address or an action', () => {
    expect(authEmailPayloadSchema.safeParse({ user: {}, email_data: {} }).success).toBe(false)
  })
})

describe('planAuthEmail for MyDomainsHub Mail (MAIL-SPEC M5)', () => {
  const MAIL = 'https://emails.mydomainshub.com'

  it('words a Mail sign-up as Mail’s, with a token-hash link back to Mail', () => {
    const [email] = sent(
      planAuthEmail(payload('signup', { redirect_to: `${MAIL}/invite?token=abc` }), APP),
    )
    expect(email).toMatchObject({
      to: 'ada@example.com',
      subject: 'Confirm your email',
      tags: ['auth', 'signup', 'mail'],
    })
    const link = linkIn(email?.html ?? '')
    expect(link.origin + link.pathname).toBe(`${MAIL}/auth/confirm`)
    expect(Object.fromEntries(link.searchParams)).toEqual({
      token_hash: 'hash-1',
      type: 'email',
      next: '/invite?token=abc',
    })
    expect(email?.html).toMatch(/alt=""[^>]*>MyDomainsHub Mail</)
    expect(email?.text.startsWith('MyDomainsHub Mail\n')).toBe(true)
    expect(email?.text).toContain('finish creating your MyDomainsHub Mail account')
    expect(email?.text).not.toContain('www.mydomainshub.com/auth')
  })

  it('links to Mail on localhost:3001 in development', () => {
    const [email] = sent(
      planAuthEmail(payload('signup', { redirect_to: 'http://localhost:3001/dashboard' }), APP),
    )
    const link = linkIn(email?.html ?? '')
    expect(link.origin + link.pathname).toBe('http://localhost:3001/auth/confirm')
    expect(link.searchParams.get('next')).toBe('/dashboard')
  })

  it('knows Mail by the site when there is no redirect, and lands on the dashboard', () => {
    const [email] = sent(planAuthEmail(payload('magiclink', { site_url: MAIL }), APP))
    expect(email?.subject).toBe('Your sign-in link')
    expect(email?.text).toContain('sign in to MyDomainsHub Mail')
    expect(linkIn(email?.html ?? '').searchParams.get('next')).toBe('/dashboard')
  })

  it('sends a Mail reset to Mail’s new-password page and says the password is shared', () => {
    const [email] = sent(planAuthEmail(payload('recovery', { redirect_to: `${MAIL}/x` }), APP))
    const link = linkIn(email?.html ?? '')
    expect(link.origin + link.pathname).toBe(`${MAIL}/auth/confirm`)
    expect(link.searchParams.get('type')).toBe('recovery')
    expect(link.searchParams.get('next')).toBe('/reset-password')
    expect(email?.text).toContain(
      'One password signs you in to MyDomainsHub Mail and the MyDomainsHub domain shop',
    )
    expect(email?.text).toMatch(/paused for 24 hours/)
  })

  it('confirms a Mail email change at both addresses, landing on Mail’s security page', () => {
    const emails = sent(
      planAuthEmail(
        payload(
          'email_change',
          { token_hash: 'for-new', token_hash_new: 'for-current', redirect_to: MAIL },
          { new_email: 'ada.new@example.com' },
        ),
        APP,
      ),
    )
    expect(emails.map((email) => email.to)).toEqual(['ada.new@example.com', 'ada@example.com'])
    for (const email of emails) {
      const link = linkIn(email.html)
      expect(link.origin).toBe(MAIL)
      expect(link.searchParams.get('next')).toBe('/dashboard/settings/security')
    }
    expect(linkIn(emails[1]?.html ?? '').searchParams.get('token_hash')).toBe('for-current')
  })

  it('sends Mail’s verification code without a link', () => {
    const [email] = sent(planAuthEmail(payload('reauthentication', { site_url: MAIL }), APP))
    expect(email?.text).toContain('Your code: 123456')
    expect(email?.text).toContain('in MyDomainsHub Mail')
  })

  it.each([
    ['signup', { token_hash: '' }, {}],
    ['magiclink', { token_hash: '' }, {}],
    ['recovery', { token_hash: '' }, {}],
    ['email_change', {}, {}],
    ['email_change', { token_hash: '', token_hash_new: '' }, { new_email: 'b@example.com' }],
    ['reauthentication', { token: '' }, {}],
    ['invite', {}, {}],
  ])(
    'sends nothing for Mail’s %s without what it needs, or an action we do not use',
    (type, data, user) => {
      expect(planAuthEmail(payload(type, { ...data, redirect_to: MAIL }, user), APP).kind).toBe(
        'skip',
      )
    },
  )

  it('keeps the shop’s email exactly as it was for every other origin, lookalikes included', () => {
    const shop = planAuthEmail(payload('signup', { redirect_to: `${APP}/app/domains` }), APP)
    for (const redirect of [
      `${APP}/app/domains`,
      'https://emails.mydomainshub.com.evil.test/x',
      'https://evil.test/emails.mydomainshub.com',
      'http://localhost:3000/app',
      'not a url',
    ]) {
      const plan = planAuthEmail(
        payload('signup', { redirect_to: redirect, site_url: 'https://www.mydomainshub.com' }),
        APP,
      )
      const [email] = sent(plan)
      expect(linkIn(email?.html ?? '').origin).toBe(APP)
      expect(email?.html).not.toContain('MyDomainsHub Mail')
      expect(email?.tags).toEqual(['auth', 'signup'])
    }
    // Byte for byte: a site on the payload changes nothing for the shop.
    expect(
      planAuthEmail(
        payload('signup', {
          redirect_to: `${APP}/app/domains`,
          site_url: 'https://www.mydomainshub.com',
        }),
        APP,
      ),
    ).toEqual(shop)
  })

  it('reads only the two fixed Mail origins', () => {
    expect(mailOrigin('https://emails.mydomainshub.com/a?b=c')).toBe(MAIL)
    expect(mailOrigin('http://emails.mydomainshub.com')).toBe(MAIL)
    expect(mailOrigin('http://localhost:3001')).toBe('http://localhost:3001')
    expect(mailOrigin('http://localhost:3000')).toBeNull()
    expect(mailOrigin('')).toBeNull()
  })
})
