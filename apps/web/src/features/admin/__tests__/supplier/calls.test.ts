import { describe, expect, it } from 'vitest'
import {
  CALL_OPERATIONS,
  callsHref,
  defaultSummaryRange,
  formatDuration,
  operationLabel,
  parseCallsSearch,
} from '@/features/admin/lib/supplier-calls'

const JOB = '0B6F3C4E-1D2A-4B5C-8D7E-9F0A1B2C3D4E'

describe('the calls page’s address', () => {
  it('reads outcomes, an operation it knows and a job id; nothing else', () => {
    const params = parseCallsSearch({
      status: 'unknown,blocked,exploded',
      op: 'RegisterWithContactInfo',
      job: JOB,
    })
    expect(params.status).toEqual(['unknown', 'blocked'])
    expect(params.op).toBe('RegisterWithContactInfo')
    expect(params.job).toBe(JOB.toLowerCase())
    expect(params.per).toBe(50)
    expect(parseCallsSearch({ op: 'DropTables', job: 'example.com' })).toMatchObject({
      op: null,
      job: null,
    })
  })

  it('builds links from parsed values, back to page 1 when a filter changes', () => {
    const params = parseCallsSearch({ status: 'ok', page: '2', op: 'Renew' })
    expect(callsHref(params, { page: 3 })).toBe('/admin/supplier/calls?status=ok&page=3&op=Renew')
    expect(callsHref(params, { op: null })).toBe('/admin/supplier/calls?status=ok')
    expect(callsHref(params, { job: JOB.toLowerCase() })).toBe(
      `/admin/supplier/calls?status=ok&op=Renew&job=${JOB.toLowerCase()}`,
    )
    expect(callsHref(parseCallsSearch({}), { sort: 'duration', dir: 'desc' })).toBe(
      '/admin/supplier/calls?sort=duration',
    )
  })

  it('names each operation, and shows an unknown one as itself', () => {
    expect(operationLabel('RegisterWithContactInfo')).toBe('Register')
    expect(operationLabel('AdminTransferQuery')).toBe('Admin: read a transfer')
    expect(operationLabel('Unheard')).toBe('Unheard')
    expect(CALL_OPERATIONS).toContain('ModifyNameServer')
  })

  it('writes durations people read at a glance', () => {
    expect(formatDuration(820)).toBe('820 ms')
    expect(formatDuration(2400)).toBe('2.4 s')
    expect(formatDuration(null)).toBe('—')
  })

  it('summarises the last 7 Lagos days by default, today included', () => {
    // 23:30 UTC on 3 Oct is 00:30 on 4 Oct in Lagos.
    expect(defaultSummaryRange(new Date('2026-10-03T23:30:00Z'))).toEqual({
      from: '2026-09-28',
      to: '2026-10-04',
    })
  })
})
