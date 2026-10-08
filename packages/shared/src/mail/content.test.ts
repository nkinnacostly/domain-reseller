import { describe, expect, it } from 'vitest'
import {
  CONTENT_MESSAGES,
  contentRefusal,
  imitates,
  isExecutable,
  linksToShortener,
  PROTECTED_NAMES,
  splitMailbox,
} from './content'

/** MAIL-SPEC §7.6: content checks at queue time — cheap and certain only. */

const plain = { html: '<p>Your receipt</p>', text: 'Your receipt' }

describe('a From that imitates a bank or a government body', () => {
  it.each([
    ['GTBank Alerts <alerts@acme.ng>', 'GTBank'],
    ['"Zenith Bank" <no-reply@acme.ng>', 'Zenith Bank'],
    ['Security <alerts@gtbank-secure.com>', 'GTBank'],
    ['Notices <hello@accessbank.verify.ng>', 'Access Bank'],
    ['CBN Grant Office <grants@funds.ng>', 'Central Bank of Nigeria'],
    ['EFCC <case@efcc-ng.org>', 'EFCC'],
    ['Opay Support <help@acme.ng>', 'Opay'],
    ['Paystack Payouts <payouts@pay.example>', 'Paystack'],
    ['Économie <x@flutterwave.ng>', 'Flutterwave'],
  ])('%s → %s', (from, body) => {
    expect(imitates(from)).toBe(body)
    expect(contentRefusal({ from, ...plain })).toEqual({
      rule: 'impersonation',
      message: CONTENT_MESSAGES.impersonation,
    })
  })

  it('reads whole words only: a surname, a country or a plain word is not a bank', () => {
    for (const from of [
      'Chidi Uba <chidi@ubaconsult.ng>',
      'Cuba Travel <hello@cubatravel.ng>',
      'The Firs Hotel <stay@firs-hotel.ng>',
      'Accessible Design <hi@accessible.ng>',
      'Receipts <receipts@acme.ng>',
      'receipts@acme.ng',
    ]) {
      expect(imitates(from), from).toBeNull()
      expect(contentRefusal({ from, ...plain }), from).toBeNull()
    }
  })

  it('lets a government body send as itself from a .gov.ng domain, and never a bank from one', () => {
    expect(imitates('EFCC <press@efcc.gov.ng>')).toBeNull()
    expect(imitates('JAMB <results@jamb.gov.ng>')).toBeNull()
    expect(imitates('GTBank <x@agency.gov.ng>')).toBe('GTBank')
    expect(imitates('EFCC <press@efcc.gov.ng.evil.com>')).toBe('EFCC')
  })

  it('lists banks and payment companies apart from the government bodies', () => {
    expect(PROTECTED_NAMES.filter((body) => body.government).map((body) => body.name)).toContain(
      'EFCC',
    )
    expect(PROTECTED_NAMES.find((body) => body.name === 'GTBank')?.government).toBeUndefined()
  })

  it('splits a mailbox into its display name and its domain', () => {
    expect(splitMailbox('"Acme, Ltd" <Receipts@Acme.NG>')).toEqual({
      name: 'Acme, Ltd',
      domain: 'acme.ng',
    })
    expect(splitMailbox('receipts@acme.ng')).toEqual({ name: '', domain: 'acme.ng' })
  })
})

describe('links through a URL shortener', () => {
  it('refuses a shortened link in the html or the text, any case, any subdomain', () => {
    expect(linksToShortener('<a href="https://bit.ly/3xYz">pay</a>')).toBe(true)
    expect(linksToShortener(null, 'Go to HTTP://TinyURL.com/abc now')).toBe(true)
    expect(linksToShortener('<a href="https://www.cutt.ly/x?y=1">')).toBe(true)
    expect(
      contentRefusal({ from: 'a@acme.ng', html: '<a href="https://t.co/x">x</a>' })?.rule,
    ).toBe('url_shortener')
  })

  it('lets ordinary links and look-alike hosts through', () => {
    expect(
      linksToShortener(
        '<a href="https://acme.ng/orders/12">order</a>',
        'see https://bitly.example.ng/x',
      ),
    ).toBe(false)
    expect(linksToShortener('bit.ly/x without a scheme is text')).toBe(false)
    expect(linksToShortener(undefined, null)).toBe(false)
  })
})

describe('attachments that are programs', () => {
  it.each([
    [{ filename: 'invoice.exe', content_type: 'application/pdf' }, true],
    [{ filename: 'INVOICE.PDF.JS', content_type: 'text/plain' }, true],
    [{ filename: 'setup.msi. ', content_type: null }, true],
    [{ filename: 'app.apk', content_type: undefined }, true],
    [{ filename: 'report', content_type: 'application/x-msdownload' }, true],
    [{ filename: 'run.sh', content_type: 'application/x-sh; charset=utf-8' }, true],
    [{ filename: 'invoice.pdf', content_type: 'application/pdf' }, false],
    [{ filename: 'photo.jpeg', content_type: 'image/jpeg' }, false],
    [{ filename: null, content_type: null }, false],
  ])('%o → %s', (attachment, executable) => {
    expect(isExecutable(attachment)).toBe(executable)
  })

  it('refuses the email when any attachment is one', () => {
    expect(
      contentRefusal({
        from: 'a@acme.ng',
        ...plain,
        attachments: [
          { filename: 'a.pdf', content_type: 'application/pdf' },
          { filename: 'b.scr' },
        ],
      })?.rule,
    ).toBe('executable_attachment')
    expect(contentRefusal({ from: 'a@acme.ng', ...plain, attachments: [] })).toBeNull()
  })

  it('names the rule, never what it read', () => {
    const refusal = contentRefusal({ from: 'GTBank <ada@acme.ng>', ...plain })
    expect(JSON.stringify(refusal)).not.toContain('ada@acme.ng')
  })
})
