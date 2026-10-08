import { describe, expect, it } from 'vitest'
import { EMAIL_BRAND, escapeHtml, isReservedAddress, renderEmail } from './layout'
import {
  certificateFailureReason,
  daysUntil,
  failureReason,
  isNoticeKind,
  lagosDate,
  lagosDateTime,
  MAIL_PRODUCT,
  MAIL_SITE_URL,
  NOTICE_TEMPLATES,
  type NoticeKind,
  percent,
  renderNotice,
} from './notices'

const NOW = new Date('2026-09-24T12:00:00Z')
const CONTEXT = { siteUrl: 'https://www.mydomainshub.com', testMode: false, now: NOW }
const AT = '2026-09-24T13:05:00Z'

/** A valid example of every kind's data, as the database queues it. */
const SAMPLES: Record<NoticeKind, Record<string, unknown>> = {
  order_receipt: {
    order_id: 'order-1',
    order_number: 'ND-001040',
    invoice_number: 'INV-000012',
    paid_at: AT,
    subtotal_kobo: 1830000,
    vat_pct: 7.5,
    vat_kobo: 137250,
    total_kobo: 1967250,
    lines: [
      {
        domain: 'getpaid.com',
        kind: 'register',
        years: 1,
        price_kobo: 1830000,
        renewal_kobo: 1860000,
      },
    ],
  },
  domain_registered: { domain: 'getpaid.com', expires_at: '2027-09-24T11:44:10Z' },
  domain_renewed: { domain: 'getpaid.com', years: 2, expires_at: '2029-09-24T11:44:10Z' },
  transfer_started: { domain: 'getpaid.com' },
  transfer_completed: { domain: 'getpaid.com', expires_at: '2027-03-01T00:00:00Z' },
  ssl_ready: {
    certificate_id: 'cert-1',
    name: 'getpaid.com',
    product: 'Sectigo PositiveSSL Certificate',
  },
  ssl_issued: {
    certificate_id: 'cert-1',
    name: '*.getpaid.com',
    expires_at: '2027-04-20T11:00:00Z',
  },
  order_line_failed: { domain: 'getpaid.com', action: 'registration', code: 'DOMAIN_TAKEN' },
  refund_sent: {
    order_id: 'order-1',
    order_number: 'ND-001040',
    amount_kobo: 1967250,
    reason: 'registration_failed',
    domain: 'getpaid.com',
  },
  nameservers_changed: { domain: 'getpaid.com', nameservers: ['ns1.vercel-dns.com'], at: AT },
  transfer_lock_changed: { domain: 'getpaid.com', locked: false, at: AT },
  contacts_changed: { domain: 'getpaid.com', at: AT },
  auth_code_revealed: { domain: 'getpaid.com', at: AT },
  new_sign_in: { device: 'Safari on iOS', at: AT },
  password_changed: { at: AT },
  two_factor_on: { at: AT },
  two_factor_off: { at: AT },
  expiry_notice: {
    domain: 'getpaid.com',
    expires_at: '2026-10-24T12:00:00Z',
    notice: 'errp_pre_35',
  },
  undelegated_nudge: { domain: 'getpaid.com' },
  mail_invite: {
    accountName: 'Acme Ltd',
    invitedBy: 'Ada Obi',
    role: 'developer',
    expiresAt: AT,
    token: 'a'.repeat(43),
  },
  mail_cap_reached: {
    accountName: 'Acme Ltd',
    scope: 'day',
    level: 80,
    cap: 5000,
    used: 4000,
    plan: 'Starter',
  },
  mail_past_due: {
    accountName: 'Acme Ltd',
    plan: 'Starter',
    amountKobo: 2150000,
    pastDueUntil: '2026-10-15T09:00:00Z',
  },
  mail_plan_lapsed: { accountName: 'Acme Ltd', plan: 'Starter' },
  mail_webhook_disabled: {
    accountName: 'Acme Ltd',
    endpoint: 'hooks.acme.example',
    failingSince: AT,
  },
  mail_account_paused: {
    accountName: 'Acme Ltd',
    reason: 'bounce_rate',
    bouncePpm: 43000,
    windowDays: 7,
  },
  mail_sending_warning: {
    accountName: 'Acme Ltd',
    source: 'threshold',
    kind: 'bounce_warning',
    bouncePpm: 21000,
    pausePpm: 40000,
    windowDays: 7,
  },
}

const render = (kind: string, data: unknown, context = CONTEXT) => {
  const outcome = renderNotice(kind, data, context)
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome.notice
}

describe('renderEmail', () => {
  it('escapes everything it prints, so no value can inject markup', () => {
    const { html, text } = renderEmail({
      heading: '<b>x</b>',
      blocks: [
        { kind: 'text', text: 'o\'brien & "co"' },
        { kind: 'list', items: ['<ns1>'] },
        { kind: 'rows', rows: [{ label: '<a>', detail: '<d>', value: '₦1' }] },
        { kind: 'note', text: '<note>' },
      ],
      action: { label: 'Go', href: 'https://x.test/?a=1&b=<2>' },
    })
    expect(html).not.toMatch(/<b>x<\/b>|<ns1>|<a>|<d>|<note>/)
    expect(html).toContain('o&#39;brien &amp; &quot;co&quot;')
    expect(html).toContain('href="https://x.test/?a=1&amp;b=&lt;2&gt;"')
    expect(text).toContain('<a> (<d>): ₦1')
    expect(escapeHtml(`'`)).toBe('&#39;')
  })

  it('opens with the brand and ends with the support address, in both forms', () => {
    const { html, text } = renderEmail({ heading: 'H', blocks: [], action: { code: '123456' } })
    expect(html).toContain(`src="${EMAIL_BRAND.markUrl}"`)
    expect(html).toContain('123456')
    expect(text.startsWith('MyDomainsHub\n\nH\n')).toBe(true)
    expect(text).toContain('Your code: 123456')
    expect(text.trimEnd().endsWith(`write to ${EMAIL_BRAND.supportEmail}.`)).toBe(true)
  })

  it('heads a product’s email with the product’s name, escaped, and the company’s by default', () => {
    const product = renderEmail({ product: 'MyDomainsHub <Mail>', heading: 'H', blocks: [] })
    expect(product.html).toMatch(/alt=""[^>]*>MyDomainsHub &lt;Mail&gt;</)
    expect(product.text.startsWith('MyDomainsHub <Mail>\n\nH\n')).toBe(true)
    const plain = renderEmail({ heading: 'H', blocks: [] })
    expect(plain.html).toMatch(/alt=""[^>]*>MyDomainsHub</)
  })
})

describe('renderNotice', () => {
  it.each(Object.keys(SAMPLES) as NoticeKind[])(
    'renders %s, versioned, with a link into the site',
    (kind) => {
      const notice = render(kind, SAMPLES[kind])
      expect(notice.version).toBe(`${kind}@${NOTICE_TEMPLATES[kind].version}`)
      expect(notice.category).toBe(NOTICE_TEMPLATES[kind].category)
      expect(notice.tags).toEqual([notice.category, kind])
      expect(notice.subject.length).toBeGreaterThan(5)
      // MyDomainsHub Mail's notices link to Mail, and come from it by name.
      const site = kind.startsWith('mail_') ? MAIL_SITE_URL : 'https://www.mydomainshub.com'
      expect(notice.html).toContain(`href="${site}/`)
      expect(notice.text).toContain(`${site}/`)
      expect(notice.fromName).toBe(kind.startsWith('mail_') ? MAIL_PRODUCT : EMAIL_BRAND.name)
    },
  )

  it('covers every kind the database queues', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(NOTICE_TEMPLATES).sort())
    expect(isNoticeKind('order_receipt')).toBe(true)
    expect(isNoticeKind('toString')).toBe(false)
  })

  it('refuses a kind it has no template for, or data the template cannot use', () => {
    expect(renderNotice('marketing_blast', {}, CONTEXT)).toEqual({
      ok: false,
      reason: 'unknown kind marketing_blast',
    })
    const bad = renderNotice('order_receipt', { order_number: 'x', lines: [] }, CONTEXT)
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.reason).toMatch(/^bad data for order_receipt: /)
  })

  it('puts every line’s renewal price on the receipt (N8), and the totals', () => {
    const { text } = render('order_receipt', SAMPLES.order_receipt)
    expect(text).toContain('getpaid.com (Registration, 1 year · renews at ₦18,600/yr): ₦18,300')
    expect(text).toContain('VAT (7.5%): ₦1,373')
    expect(text).toContain('Total: ₦19,673')
    expect(text).toContain('Invoice number: INV-000012')
    expect(text).toContain('https://www.mydomainshub.com/app/orders/order-1/receipt')
  })

  it('words a renewal sold only in blocks by its block, never per year (N8, N9b)', () => {
    const { text, version } = render('order_receipt', {
      ...SAMPLES.order_receipt,
      lines: [
        {
          domain: 'getpaid.ai',
          kind: 'register',
          years: 2,
          price_kobo: 27300000,
          renewal_kobo: 13650000,
          renewal_years: 2,
        },
      ],
    })
    expect(text).toContain(
      'getpaid.ai (Registration, 2 years · renews at ₦273,000 every 2 years): ₦273,000',
    )
    expect(text).not.toContain('/yr')
    expect(version).toBe('order_receipt@3')
  })

  it('words a certificate line by its term and the price of a new one (FR-SSL-6, N8)', () => {
    const { text } = render('order_receipt', {
      ...SAMPLES.order_receipt,
      lines: [
        {
          domain: 'getpaid.com',
          kind: 'ssl',
          years: 1,
          price_kobo: 1350000,
          renewal_kobo: 1350000,
          product: 'Sectigo PositiveSSL Certificate',
        },
      ],
    })
    expect(text).toContain(
      'getpaid.com (Sectigo PositiveSSL Certificate, 1-year subscription · a new one is ₦13,500 at today’s price): ₦13,500',
    )
    expect(text).toContain('as each certificate is done')
    expect(text).not.toMatch(/renews at|valid for/)
  })

  it('says "item" for an order of domains and certificates together', () => {
    const { text } = render('order_receipt', {
      ...SAMPLES.order_receipt,
      lines: [
        ...(SAMPLES.order_receipt.lines as unknown[]),
        { domain: 'getpaid.com', kind: 'ssl', years: 1, price_kobo: 1, renewal_kobo: 1 },
      ],
    })
    expect(text).toContain('as each item is done')
    expect(text).toContain('getpaid.com (SSL certificate, 1-year subscription')
  })

  it('marks a test-mode email in the subject and the body', () => {
    const notice = render('order_receipt', SAMPLES.order_receipt, { ...CONTEXT, testMode: true })
    expect(notice.subject).toBe('[Test] Receipt for order ND-001040')
    expect(notice.text).toContain('no money moved')
  })

  it('greets by first name when there is one, and not with anything odd', () => {
    expect(render('password_changed', { ...SAMPLES.password_changed, name: 'Ada' }).text).toContain(
      'Hi Ada,',
    )
    expect(
      render('password_changed', { ...SAMPLES.password_changed, name: null }).text,
    ).not.toContain('Hi ')
    expect(
      render('password_changed', { ...SAMPLES.password_changed, name: 'x'.repeat(41) }).text,
    ).not.toContain('Hi ')
  })

  it('tells people every security notice is one they cannot switch off, and what to do if it was not them', () => {
    for (const kind of Object.keys(SAMPLES) as NoticeKind[]) {
      if (NOTICE_TEMPLATES[kind].category !== 'security') continue
      const { text } = render(kind, SAMPLES[kind])
      expect(text, kind).toContain('cannot be switched off')
      expect(text, kind).toMatch(/If you did not (do|change) (this|it)/)
    }
  })

  it('names the device and the time of a new sign-in, in Lagos time', () => {
    expect(render('new_sign_in', SAMPLES.new_sign_in).text).toContain(
      'signed in from Safari on iOS on 24 September 2026 at 14:05 (Lagos time)',
    )
  })

  it('says which way the transfer lock went', () => {
    expect(render('transfer_lock_changed', SAMPLES.transfer_lock_changed).subject).toBe(
      'Transfer lock turned off for getpaid.com',
    )
    const on = render('transfer_lock_changed', { ...SAMPLES.transfer_lock_changed, locked: true })
    expect(on.subject).toBe('Transfer lock turned on for getpaid.com')
    expect(on.text).not.toContain('Turn the lock back on')
  })

  it('explains a failure in our words, never the supplier’s (N10), and promises the refund', () => {
    const taken = render('order_line_failed', SAMPLES.order_line_failed)
    expect(taken.subject).toBe('We could not register getpaid.com')
    expect(taken.text).toContain('Someone else registered this name before we could.')
    expect(taken.text).toContain('back what you paid for it, VAT included')
    const renewal = render('order_line_failed', {
      domain: 'a.com',
      action: 'renewal',
      code: 'API_999',
    })
    expect(renewal.subject).toBe('We could not renew a.com')
    expect(renewal.text).toContain('The registry could not complete it.')
    expect(render('order_line_failed', { domain: 'a.com', action: 'transfer' }).subject).toBe(
      'The transfer of a.com did not complete',
    )
  })

  it('says a certificate could not be ordered, why, and that it is refunded (FR-SSL-3)', () => {
    const certificate = render('order_line_failed', {
      domain: 'getpaid.com',
      action: 'certificate',
      code: 'NAME_HAS_CERTIFICATE',
    })
    expect(certificate.subject).toBe('We could not order the SSL certificate for getpaid.com')
    expect(certificate.text).toContain('No certificate for getpaid.com')
    expect(certificate.text).toContain('already holds a certificate for this name')
    expect(certificate.text).toContain('back what you paid for it, VAT included')
    expect(certificate.version).toBe('order_line_failed@2')
    // Never "the registry" for a certificate.
    const unknownCode = render('order_line_failed', {
      domain: 'a.com',
      action: 'certificate',
      code: 'X',
    })
    expect(unknownCode.text).toContain('Our certificate supplier would not take the order.')
    expect(unknownCode.text).not.toContain('registry')
  })

  it('sends people to set up a certificate once it is ordered, and to download it once issued', () => {
    const ready = render('ssl_ready', SAMPLES.ssl_ready)
    expect(ready.subject).toBe('Set up your SSL certificate for getpaid.com')
    expect(ready.text).toContain('https://www.mydomainshub.com/app/ssl/cert-1')
    expect(ready.text).toContain('at most 200 days')
    const issued = render('ssl_issued', SAMPLES.ssl_issued)
    expect(issued.subject).toBe('Your SSL certificate for *.getpaid.com is issued')
    expect(issued.text).toContain('It expires on 20 April 2027.')
    expect(issued.text).toContain('We do not install certificates for you.')
    expect(render('ssl_issued', { ...SAMPLES.ssl_issued, expires_at: null }).text).toContain(
      'The certificate authority issued your certificate.',
    )
  })

  it('says how much is refunded, why, and how long a card refund takes', () => {
    const notice = render('refund_sent', SAMPLES.refund_sent)
    expect(notice.subject).toBe('Your refund of ₦19,673 is on its way')
    expect(notice.text).toContain('because getpaid.com could not be registered')
    expect(notice.text).toContain('up to 15 business days')
    expect(
      render('refund_sent', { ...SAMPLES.refund_sent, reason: 'duplicate_charge', domain: null })
        .text,
    ).toContain('because you were charged twice')
    expect(render('refund_sent', { ...SAMPLES.refund_sent, reason: 'mystery' }).text).toContain(
      'as agreed',
    )
  })

  it.each([
    ['renewal_failed', 'because getpaid.com could not be renewed'],
    ['transfer_failed', 'because the transfer of getpaid.com did not complete'],
    ['overpayment', 'for the amount you paid over the order total'],
    ['underpayment', 'less than the order total, which paid for nothing'],
    ['empty_order', 'an order with nothing in it'],
    ['ssl_failed', 'because the SSL certificate for getpaid.com could not be ordered'],
  ])('gives the reason for a %s refund', (reason, words) => {
    expect(render('refund_sent', { ...SAMPLES.refund_sent, reason }).text).toContain(words)
  })

  it('names no domain it does not have', () => {
    expect(
      render('refund_sent', { ...SAMPLES.refund_sent, reason: 'renewal_failed', domain: null })
        .text,
    ).toContain('because a domain could not be renewed')
  })

  describe('ERRP notices (§7.4)', () => {
    it('counts the days to expiry for the notices before it', () => {
      const month = render('expiry_notice', SAMPLES.expiry_notice)
      expect(month.subject).toBe('getpaid.com expires in 30 days')
      expect(month.category).toBe('compliance')
      expect(month.text).toContain('expires on 24 October 2026')
      expect(month.text).toContain('/app/domains/getpaid.com/renew')
      const week = render('expiry_notice', {
        ...SAMPLES.expiry_notice,
        expires_at: '2026-09-25T13:00:00Z',
        notice: 'errp_pre_7',
      })
      expect(week.subject).toBe('getpaid.com expires in 1 day')
    })

    it('tells how to restore after expiry — required in the post-expiry notice', () => {
      const after = render('expiry_notice', {
        ...SAMPLES.expiry_notice,
        expires_at: '2026-09-22T12:00:00Z',
        notice: 'errp_post',
      })
      expect(after.subject).toBe('getpaid.com has expired')
      expect(after.text).toContain('grace period')
      expect(after.text).toContain('redemption')
      expect(after.text).toContain('restore fee')
      expect(after.text).toContain('required renewal reminder')
    })
  })

  it('points an unused domain at the nameserver page, once', () => {
    const nudge = render('undelegated_nudge', SAMPLES.undelegated_nudge)
    expect(nudge.text).toContain('/app/domains/getpaid.com/nameservers')
    expect(nudge.text).toContain('We send this once.')
  })

  it('writes a domain with no expiry date yet without one', () => {
    expect(render('domain_registered', { domain: 'a.com' }).text).toContain(
      'It is registered to you.',
    )
    expect(render('transfer_completed', { domain: 'a.com' }).text).toContain('now in your account.')
  })
})

describe('MyDomainsHub Mail’s notices (MAIL-SPEC §15, migration 58)', () => {
  it('invites with the one-time link, the role and the deadline, under Mail’s name', () => {
    const invite = render('mail_invite', SAMPLES.mail_invite)
    expect(invite.subject).toBe('Ada Obi invited you to Acme Ltd on MyDomainsHub Mail')
    expect(invite.text).toContain(`${MAIL_SITE_URL}/invite?token=${'a'.repeat(43)}`)
    expect(invite.text).toContain('as a developer')
    expect(invite.text).toContain('only for this email address')
    expect(invite.html).toContain('MyDomainsHub Mail')
    expect(
      renderNotice('mail_invite', { ...SAMPLES.mail_invite, token: 'short' }, CONTEXT).ok,
    ).toBe(false)
  })

  it('links to the Mail site a test names', () => {
    const rendered = renderNotice('mail_plan_lapsed', SAMPLES.mail_plan_lapsed, {
      ...CONTEXT,
      mailUrl: 'http://localhost:3301/',
    })
    expect(rendered.ok && rendered.notice.text).toContain('http://localhost:3301/dashboard/billing')
  })

  it('words a cap at 80% and at 100%, by the day and the month, with when it resets', () => {
    const near = render('mail_cap_reached', SAMPLES.mail_cap_reached)
    expect(near.subject).toBe('Acme Ltd has used 80% of its daily sending limit')
    expect(near.text).toContain('4,000 of its 5,000 emails a day on the Starter plan')
    expect(near.text).toContain('at midnight, Lagos time')
    const full = render('mail_cap_reached', {
      ...SAMPLES.mail_cap_reached,
      scope: 'month',
      level: 100,
    })
    expect(full.subject).toBe('Acme Ltd has reached its monthly sending limit')
    expect(full.text).toContain('quota_exceeded')
    expect(full.text).toContain('on the first day of next month')
    expect(
      renderNotice('mail_cap_reached', { ...SAMPLES.mail_cap_reached, level: 50 }, CONTEXT).ok,
    ).toBe(false)
  })

  it('says how long a past-due plan keeps working, and what it costs, to the owner', () => {
    const due = render('mail_past_due', SAMPLES.mail_past_due)
    expect(due.text).toContain('₦21,500')
    expect(due.text).toContain('Sending carries on until 15 October 2026')
    expect(due.text).toContain('as the owner of Acme Ltd')
    expect(render('mail_plan_lapsed', SAMPLES.mail_plan_lapsed).text).toContain(
      'moved to the Free plan',
    )
  })

  it('names a disabled webhook by its host only', () => {
    const hook = render('mail_webhook_disabled', SAMPLES.mail_webhook_disabled)
    expect(hook.text).toContain('Your endpoint at hooks.acme.example')
    expect(hook.text).toContain('/dashboard/webhooks')
  })

  it('says why sending is paused, for each way it can be', () => {
    expect(render('mail_account_paused', SAMPLES.mail_account_paused).text).toContain(
      'bounced (4.3% over the last 7 days)',
    )
    expect(
      render('mail_account_paused', {
        accountName: 'Acme Ltd',
        reason: 'complaint_rate',
        complaintPpm: 900,
      }).text,
    ).toContain('reported Acme Ltd’s recent emails as spam (0.09%)')
    expect(
      render('mail_account_paused', { accountName: 'Acme Ltd', reason: 'ses' }).text,
    ).toContain('Amazon SES paused sending')
    const admin = render('mail_account_paused', { accountName: 'Acme Ltd', reason: 'admin' })
    expect(admin.text).toContain('Our team paused sending on Acme Ltd.')
    expect(admin.text).toContain('the API refuses new emails')
  })

  it('warns before a pause, with the rate and the line, or in SES’s own words', () => {
    const warn = render('mail_sending_warning', SAMPLES.mail_sending_warning)
    expect(warn.subject).toBe('Acme Ltd: bounces are getting high')
    expect(warn.text).toContain(
      'Over the last 7 days, 2.1% of Acme Ltd’s emails bounced. At 4% we pause',
    )
    const ses = render('mail_sending_warning', {
      accountName: 'Acme Ltd',
      source: 'ses',
      kind: 'bounce',
      summary: 'The bounce rate exceeded 5%.',
    })
    expect(ses.subject).toBe('Amazon SES flagged Acme Ltd’s sending')
    expect(ses.text).toContain('The bounce rate exceeded 5%.')
  })

  it('writes rates as mail.ppm_text does', () => {
    expect(percent(43_000)).toBe('4.3%')
    expect(percent(523)).toBe('0.052%')
    expect(percent(800)).toBe('0.08%')
    expect(percent(40_000)).toBe('4%')
  })
})

describe('isReservedAddress', () => {
  it('knows the names that can never receive mail', () => {
    for (const address of [
      'e2e-1@example.com',
      'a@EXAMPLE.org',
      'x@shop.test',
      'y@z.invalid',
      'root@localhost',
      'no-at-sign',
      '@example.com',
    ]) {
      expect(isReservedAddress(address), address).toBe(true)
    }
    expect(isReservedAddress('ada@gmail.com')).toBe(false)
    expect(isReservedAddress('hello@mydomainshub.com')).toBe(false)
  })
})

describe('formatting', () => {
  it('writes dates as Lagos dates', () => {
    expect(lagosDate('2026-09-24T23:30:00Z')).toBe('25 September 2026')
    expect(lagosDateTime('2026-09-24T13:05:00Z')).toBe('24 September 2026 at 14:05 (Lagos time)')
  })

  it('counts whole days, never below zero', () => {
    expect(daysUntil('2026-09-25T11:00:00Z', NOW)).toBe(0)
    expect(daysUntil('2026-10-24T12:00:00Z', NOW)).toBe(30)
    expect(daysUntil('2026-09-20T12:00:00Z', NOW)).toBe(0)
  })

  it('falls back to a plain sentence for a failure code it does not know', () => {
    expect(failureReason('DOMAIN_TAKEN')).toBe('Someone else registered this name before we could.')
    expect(failureReason(null)).toBe('The registry could not complete it.')
  })

  it('words an administrator’s fail without blaming the customer (ADMIN-SPEC §3.1.2)', () => {
    expect(failureReason('NOT_AT_REGISTRY')).toBe(
      'The registry did not register it, so nothing was bought.',
    )
    expect(failureReason('TRANSFER_REFUSED')).toBe(
      'The registry refused the transfer, so the domain did not move to us.',
    )
    expect(failureReason('STOPPED_BY_ADMIN')).toBe(
      'We stopped this change. Your domain keeps the settings the registry shows.',
    )
    expect(certificateFailureReason('FAILED_BY_ADMIN')).toBe(
      'The certificate was not ordered, so nothing was bought.',
    )
  })
})
