import { describe, expect, it } from 'vitest'
import {
  asciiHost,
  validFlwRefundId,
  validId,
  validName,
  validOp,
  validQuery,
  validRange,
  validSide,
  validSkip,
  validSmallInt,
  validTake,
  validTld,
  validTrace,
  validYears,
} from './validate'

/** ADMIN-SPEC §4.2: every admin input, before a note is claimed. */

const NOW = new Date('2026-10-02T12:00:00Z')

describe('admin route inputs', () => {
  it('takes a domain name, lower-cased, in ASCII', () => {
    expect(validName('Example.COM')).toBe('example.com')
    expect(validName('café.com')).toBe('xn--caf-dma.com')
    expect(asciiHost('ÖRNEK.com')).toBe('xn--rnek-4qa.com')
    for (const bad of [
      '',
      'nodot',
      'a/b.com',
      'evil@x.com',
      'x.com:80',
      '-bad.com',
      'a b.com',
      undefined,
    ]) {
      expect(validName(bad)).toBeNull()
    }
  })

  it('takes a `*.` name only where a wildcard certificate is asked about', () => {
    expect(validName('*.example.com')).toBeNull()
    expect(validName('*.example.com', true)).toBe('*.example.com')
    expect(validName('*.*.example.com', true)).toBeNull()
  })

  it('takes an extension', () => {
    expect(validTld('COM')).toBe('com')
    expect(validTld('.com.ng')).toBe('com.ng')
    expect(validTld('c')).toBeNull()
    expect(validTld('com/../x')).toBeNull()
  })

  it('lower-cases a trace id, RFC or not, and refuses anything else', () => {
    expect(validTrace('A476642F-9956-7CE2-9B08-3A23E027661E')).toBe(
      'a476642f-9956-7ce2-9b08-3a23e027661e',
    )
    expect(validTrace('38e14b09-3eb8-b811-78ce-3a2400360393')).toBe(
      '38e14b09-3eb8-b811-78ce-3a2400360393',
    )
    expect(validTrace('38e14b093eb8b81178ce3a2400360393')).toBeNull()
    expect(validTrace(undefined)).toBeNull()
  })

  it('pages from 0 to 10,000, 1 to 100 at a time', () => {
    expect(validSkip(undefined)).toBe(0)
    expect(validSkip('10000')).toBe(10_000)
    expect(validSkip('10001')).toBeNull()
    expect(validSkip('-1')).toBeNull()
    expect(validTake(undefined)).toBe(25)
    expect(validTake('100')).toBe(100)
    expect(validTake('101')).toBeNull()
    expect(validTake('0')).toBeNull()
    expect(validTake('1.5')).toBeNull()
  })

  it('takes small enum integers, an operation and 1–10 years', () => {
    expect(validSmallInt('5')).toBe(5)
    expect(validSmallInt('21')).toBeNull()
    expect(validOp(undefined)).toBe('register')
    expect(validOp('restore')).toBe('restore')
    expect(validOp('delete')).toBeNull()
    expect(validYears(undefined)).toBe(1)
    expect(validYears('10')).toBe(10)
    expect(validYears('11')).toBeNull()
    expect(validYears('0')).toBeNull()
  })

  it('takes dates at most 366 days apart, in order, that exist', () => {
    expect(validRange(undefined, undefined, NOW)).toEqual({ from: '2026-09-26', to: '2026-10-02' })
    expect(validRange('2026-01-01', '2026-12-31', NOW)).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
    })
    expect(validRange('2025-01-01', '2026-12-31', NOW)).toBeNull()
    expect(validRange('2026-10-02', '2026-10-01', NOW)).toBeNull()
    expect(validRange('2026-02-31', '2026-03-01', NOW)).toBeNull()
    expect(validRange('02/10/2026', undefined, NOW)).toBeNull()
  })

  it('searches the live ledger by an exact hostname only', () => {
    expect(validQuery('Example.com')).toBe('example.com')
    expect(validQuery('Ziraat Payment')).toBeNull()
    expect(validQuery(undefined)).toBeNull()
  })

  it('takes Flutterwave refund ids, refund uuids and incident numbers', () => {
    expect(validFlwRefundId('123_abc-9')).toBe('123_abc-9')
    expect(validFlwRefundId('1'.repeat(65))).toBeNull()
    expect(validFlwRefundId('1;drop')).toBeNull()
    expect(validId('8DBD7EA2-C535-4A4A-A091-E202D9185A20', 'uuid')).toBe(
      '8dbd7ea2-c535-4a4a-a091-e202d9185a20',
    )
    expect(validId('not-a-uuid', 'uuid')).toBeNull()
    expect(validId('42', 'bigint')).toBe('42')
    expect(validId('4a', 'bigint')).toBeNull()
    expect(validId(undefined, 'bigint')).toBeNull()
  })

  it('takes a side', () => {
    expect(validSide('live')).toBe('live')
    expect(validSide('test')).toBe('test')
    expect(validSide('global')).toBeNull()
  })
})
