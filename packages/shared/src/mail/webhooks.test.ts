import { describe, expect, it } from 'vitest'
import {
  checkWebhookUrl,
  isPublicAddress,
  isWebhookEvent,
  isWebhookPort,
  WEBHOOK_EVENTS,
  WEBHOOK_PORTS,
  WEBHOOK_TIMEOUT_SECONDS,
  WEBHOOK_USER_AGENT,
} from './webhooks'

/**
 * Which endpoints Mail will call (MAIL-SPEC §6): https, public, and in the
 * form migration 49's `is_webhook_url` accepts — and which addresses the
 * worker may connect to.
 */

/** Migration 49's checks, as written in SQL, for the stored form. */
const SQL_URL = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?(\/[^#]*)?$/

describe('checkWebhookUrl', () => {
  it.each([
    ['https://hooks.acme.ng/mdh', 'https://hooks.acme.ng/mdh'],
    ['  https://Hooks.Acme.NG/In?source=mdh  ', 'https://hooks.acme.ng/In?source=mdh'],
    ['https://hooks.acme.ng', 'https://hooks.acme.ng/'],
    ['https://hooks.acme.ng:443/x', 'https://hooks.acme.ng/x'],
    ['https://hooks.acme.ng:8443/x#top', 'https://hooks.acme.ng:8443/x'],
    ['https://bücher.example/h', 'https://xn--bcher-kva.example/h'],
    ['https://8.8.8.8/hook', 'https://8.8.8.8/hook'],
    ['https://hooks.acme.ng/a b', 'https://hooks.acme.ng/a%20b'],
  ])('accepts %s as %s, a form SQL takes', (input, stored) => {
    const check = checkWebhookUrl(input)
    expect(check).toEqual({ ok: true, url: stored })
    if (check.ok) expect(check.url).toMatch(SQL_URL)
  })

  it.each([
    ['', 'not_url'],
    ['hooks.acme.ng/x', 'not_url'],
    ['http://hooks.acme.ng/x', 'not_https'],
    ['ftp://hooks.acme.ng/x', 'not_https'],
    ['https://user:pw@hooks.acme.ng/x', 'credentials'],
    ['https://[::1]/x', 'ip_v6'],
    ['https://[2606:4700::1111]/x', 'ip_v6'],
    ['https://127.0.0.1/x', 'private_address'],
    ['https://0x7f.1/x', 'private_address'],
    ['https://2130706433/x', 'private_address'],
    ['https://10.0.0.8/x', 'private_address'],
    ['https://169.254.169.254/latest/meta-data', 'private_address'],
    ['https://192.168.1.10/x', 'private_address'],
    ['https://localhost/x', 'internal_name'],
    ['https://api.localhost/x', 'internal_name'],
    ['https://nas.local/x', 'internal_name'],
    ['https://db.internal/x', 'internal_name'],
    ['https://router.home.arpa/x', 'internal_name'],
    ['https://hooks/x', 'internal_name'],
    ['https://hooks.acme.ng./x', 'internal_name'],
    ['https://hooks_acme.ng/x', 'internal_name'],
    [`https://hooks.acme.ng/${'a'.repeat(500)}`, 'too_long'],
    ['https://hooks.acme.ng:22/x', 'port'],
    ['https://hooks.acme.ng:6379/x', 'port'],
    ['https://hooks.acme.ng:8080/x', 'port'],
    ['https://8.8.8.8:25/x', 'port'],
    ['https://hooks.acme.ng:65535/x', 'port'],
  ])('refuses %s (%s)', (input, reason) => {
    expect(checkWebhookUrl(input)).toEqual({ ok: false, reason })
  })

  it('calls 443 and 8443 only, so no endpoint can make the worker a port scanner', () => {
    expect(WEBHOOK_PORTS).toEqual([443, 8443])
    expect([isWebhookPort(''), isWebhookPort('443'), isWebhookPort(8443)]).toEqual([
      true,
      true,
      true,
    ])
    expect([isWebhookPort('80'), isWebhookPort('8080'), isWebhookPort('x')]).toEqual([
      false,
      false,
      false,
    ])
  })
})

describe('how a delivery arrives', () => {
  it('names the worker and gives the endpoint ten seconds, as the guide says', () => {
    expect(WEBHOOK_USER_AGENT).toBe('MyDomainsHub-Mail-Webhooks/1')
    expect(WEBHOOK_TIMEOUT_SECONDS).toBe(10)
  })
})

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '41.58.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '192.0.1.1',
    '198.17.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4009:81f::200e',
    '::ffff:8.8.8.8',
    '[2001:4860:4860::8888]',
  ])('lets the worker connect to %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true)
  })

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '256.1.1.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1%en0',
    'ff02::1',
    '2001:db8::1',
    '2001::1',
    '2002:a00:1::1',
    '1:2:3:4:5:6:7',
    '1::2::3',
    '1:2:3:4:5:6:7:8:9',
    '2001:db8::zzzz',
    '::ffff:1.2.3',
    'not an address',
    '',
  ])('keeps the worker from %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false)
  })
})

describe('the events an endpoint can want', () => {
  it('are the eight of §6, and nothing else', () => {
    expect(WEBHOOK_EVENTS).toHaveLength(8)
    expect(isWebhookEvent('email.delivered')).toBe(true)
    expect(isWebhookEvent('email.opened')).toBe(false)
    expect(isWebhookEvent(42)).toBe(false)
  })
})
