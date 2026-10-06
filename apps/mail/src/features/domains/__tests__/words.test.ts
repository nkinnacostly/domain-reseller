import { describe, expect, it } from 'vitest'
import { HOST_GUIDES } from '../lib/hosts'
import { isReservedDomain, normaliseDomain, unicodeOf } from '../lib/names'
import { asDomainAnswer, DOMAIN_FALLBACK, domainApiError, domainMessage } from '../lib/results'
import {
  domainPhase,
  failureWords,
  formatWhen,
  PHASE_LABEL,
  PHASE_WORDS,
  RECORD_STATE_LABEL,
  RECORD_STATE_WORDS,
} from '../lib/status'

/** Names as typed, states and refusals in words (MAIL-SPEC §5, §6; the shop's UX-7). */

describe('a domain as typed', () => {
  it.each([
    ['Acme.Example.', 'acme.example'],
    ['  https://mail.acme.example/path?x=1 ', 'mail.acme.example'],
    ['café.example', 'xn--caf-dma.example'],
  ])('%s is %s', (input, expected) => {
    expect(normaliseDomain(input)).toBe(expected)
  })

  it.each([
    '',
    'localhost',
    'not a domain',
    'ada@acme.example',
    '*.acme.example',
    '123',
    `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(30)}.example`,
  ])('refuses %j', (input) => {
    expect(normaliseDomain(input)).toBeNull()
  })

  it('knows our own names, and shows an international name as people read it', () => {
    expect(isReservedDomain('mydomainshub.com')).toBe(true)
    expect(isReservedDomain('sandbox.emails.mydomainshub.com')).toBe(true)
    expect(isReservedDomain('notmydomainshub.com')).toBe(false)
    expect(unicodeOf('xn--caf-dma.example')).toBe('café.example')
    expect(unicodeOf('acme.example')).toBeNull()
  })
})

describe('states in words (§5)', () => {
  it('a pending domain is setting up until SES has given its records', () => {
    expect(domainPhase('pending', true)).toBe('setting_up')
    expect(domainPhase('pending', false)).toBe('pending')
    expect(domainPhase('verified', false)).toBe('verified')
    expect(domainPhase('failed', false)).toBe('failed')
    expect(domainPhase('removing', false)).toBe('removing')
    expect(domainPhase('removed', false)).toBeNull()
    expect(domainPhase('sandbox', false)).toBeNull()
    for (const phase of Object.keys(PHASE_LABEL) as (keyof typeof PHASE_LABEL)[]) {
      expect(PHASE_LABEL[phase].label).not.toBe('')
      expect(PHASE_WORDS[phase]).not.toBe('')
    }
    for (const state of Object.keys(RECORD_STATE_LABEL) as (keyof typeof RECORD_STATE_LABEL)[]) {
      expect(RECORD_STATE_WORDS[state]).not.toBe('')
    }
  })

  it('a failure names the missing record and says what to do next', () => {
    expect(failureWords('dkim_record_missing', 'x._domainkey.acme.example')).toContain(
      'The DKIM record x._domainkey.acme.example was not found in public DNS within 72 hours.',
    )
    expect(failureWords('dkim_record_missing', null)).toContain('A DKIM record was not found')
    expect(failureWords('dkim_not_verified', null)).toContain('did not confirm them')
    expect(failureWords('not_set_up', null)).toContain('could not finish')
    expect(failureWords('ses_refused', null)).toContain('would not accept')
    expect(failureWords(null, null)).toContain('try again')
  })

  it('moments in Lagos time', () => {
    expect(formatWhen(null)).toBeNull()
    expect(formatWhen('2026-10-06T09:30:00Z')).toMatch(/\(Lagos\)$/)
  })
})

describe('refusals in words', () => {
  it.each([
    ['in_use', 'in use on another account'],
    ['in_use_pending', 'still verifying it'],
    ['releasing', 'being released'],
    ['reserved', 'are ours'],
    ['validation', 'not a domain we can verify'],
    ['already_added', 'already on this account'],
    ['not_failed', 'Only a failed domain'],
    ['account_closed', 'closed'],
    ['unauthorized', 'session has ended'],
    ['not_found', 'not found'],
    ['forbidden', 'Your role'],
  ])('%s', (code, words) => {
    expect(domainMessage({ code })).toContain(words)
  })

  it('counts and dates where SQL gives them', () => {
    expect(domainMessage({ code: 'domain_limit', max: 1 })).toContain('holds 1 domain,')
    expect(domainMessage({ code: 'domain_limit', max: 5 })).toContain('holds 5 domains,')
    expect(domainMessage({ code: 'domain_limit' })).toContain('no more')
    expect(domainMessage({ code: 'emails_queued', count: 1 })).toContain('One email is')
    expect(domainMessage({ code: 'emails_queued', count: 3 })).toContain('3 emails are')
    expect(domainMessage({ code: 'in_use_pending', until: '2026-10-09T09:30:00Z' })).toMatch(
      /until .+, Lagos/,
    )
    expect(domainMessage({ code: 'forbidden', reason: 'sandbox' })).toContain(
      'sandbox sending address',
    )
    expect(domainMessage({ code: 'nonsense' })).toBe(DOMAIN_FALLBACK)
    expect(domainMessage(null)).toBe(DOMAIN_FALLBACK)
    expect(asDomainAnswer([1])).toBeNull()
    expect(asDomainAnswer('x')).toBeNull()
  })

  it('as the API answers them, never the raw code', () => {
    expect(domainApiError({ code: 'forbidden' })).toMatchObject({ name: 'forbidden', status: 403 })
    expect(domainApiError({ code: 'not_found' })).toMatchObject({ name: 'not_found', status: 404 })
    expect(domainApiError({ code: 'unauthorized' })).toMatchObject({ status: 401 })
    expect(domainApiError({ code: 'in_use' })).toMatchObject({
      name: 'validation_error',
      status: 409,
    })
    expect(domainApiError({ code: 'emails_queued', count: 2 })).toMatchObject({ status: 409 })
    expect(domainApiError({ code: 'domain_limit', max: 1 })).toMatchObject({ name: 'forbidden' })
    expect(domainApiError({ code: 'account_closed' })).toMatchObject({ name: 'forbidden' })
    expect(domainApiError({ code: 'reserved' })).toMatchObject({
      name: 'validation_error',
      status: 422,
    })
    expect(domainApiError({ code: 'validation' })).toMatchObject({ status: 422 })
    expect(domainApiError({ code: 'odd' })).toMatchObject({ name: 'internal_error', status: 500 })
  })
})

describe('host guides', () => {
  it('each from the host’s own pages, dated, with steps', () => {
    expect(HOST_GUIDES.map((guide) => guide.name)).toEqual(['Cloudflare', 'Truehost', 'Hostinger'])
    for (const guide of HOST_GUIDES) {
      expect(guide.steps.length).toBeGreaterThan(0)
      expect(guide.sources.length).toBeGreaterThan(0)
      for (const source of guide.sources) expect(source.url).toMatch(/^https:\/\//)
      expect(guide.checkedOn).toBe('2026-10-06')
    }
  })
})
