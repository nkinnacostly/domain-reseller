import { describe, expect, it } from 'vitest'
import { CSV_HEADER, csvFileName, lagosDate, portfolioCsv } from '../lib/csv'

describe('portfolioCsv (FR-P4)', () => {
  const statusText = (status: string) => (status === 'active' ? 'Active' : status)

  it('writes the header and one row per domain, in the order given', () => {
    const csv = portfolioCsv(
      [
        {
          domainName: 'getpaid.com',
          status: 'active',
          expiresAt: '2027-09-23T23:30:00Z',
          nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
          labels: [
            { id: 'l1', name: 'Acme', color: 'blue' },
            { id: 'l2', name: '=cmd', color: 'red' },
          ],
          autoRenew: true,
          transferLock: false,
          privacyEnabled: true,
        },
        {
          domainName: 'naija.ng',
          status: 'pending',
          expiresAt: null,
          nameservers: null,
          labels: [],
          autoRenew: false,
          transferLock: true,
          privacyEnabled: false,
        },
      ],
      statusText,
    )
    const [header, first, second, end] = csv.split('\r\n')
    expect(header).toBe(CSV_HEADER.join(','))
    expect(header).toBe('Domain,Status,Expires,Nameservers,Labels,Auto-renew,Transfer lock,Privacy')
    // 23:30 UTC is the next day in Lagos; "=cmd" mid-cell is not a formula.
    expect(first).toBe(
      'getpaid.com,Active,2027-09-24,ns1.vercel-dns.com ns2.vercel-dns.com,Acme; =cmd,On,Off,On',
    )
    expect(second).toBe('naija.ng,pending,,,,Off,On,Off')
    expect(end).toBe('')
  })

  it('guards a label that starts like a formula', () => {
    const csv = portfolioCsv(
      [
        {
          domainName: 'x.com',
          status: 'active',
          expiresAt: null,
          nameservers: [],
          labels: [{ id: 'l1', name: '@evil', color: 'red' }],
          autoRenew: true,
          transferLock: true,
          privacyEnabled: true,
        },
      ],
      statusText,
    )
    expect(csv.split('\r\n')[1]).toBe("x.com,Active,,,'@evil,On,On,On")
  })
})

describe('dates and file names', () => {
  it('uses the Lagos calendar day', () => {
    expect(lagosDate('2026-09-24T22:59:00Z')).toBe('2026-09-24')
    expect(lagosDate('2026-09-24T23:00:00Z')).toBe('2026-09-25')
    expect(csvFileName(new Date('2026-09-24T09:00:00Z'))).toBe('domains-2026-09-24.csv')
  })
})
