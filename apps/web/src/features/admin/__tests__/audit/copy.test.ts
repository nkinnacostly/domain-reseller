import { describe, expect, it } from 'vitest'
import { ADMIN_TIERS } from '@/features/admin/lib/actions'
import {
  ACTION_LABEL,
  actionLabel,
  gatewayResult,
  OUTCOME_CHIP,
  PREFIX_LABEL,
  targetLabel,
} from '@/features/admin/lib/audit-copy'
import { AUDIT_OUTCOMES, AUDIT_PREFIXES } from '@/features/admin/lib/audit-params'
import { auditTargetHref, auditTargetText } from '@/features/admin/lib/audit-target'
import { AUDIT_OUTCOME_LABEL } from '@/features/admin/lib/labels'

const UUID = '7a7b7c7d-8e8f-4a9b-8cad-bebfc0c1d2d3'

describe('the audit log’s words', () => {
  it('names every action admin_tier knows, and only those', () => {
    expect(Object.keys(ACTION_LABEL).sort()).toEqual(Object.keys(ADMIN_TIERS).sort())
    expect(actionLabel('refund.approve')).toBe('Approve a refund')
    expect(actionLabel('supplier.balance')).toBe('Read the live balance')
  })

  it('shows an action it does not know as its code, never hidden', () => {
    expect(actionLabel('something.new')).toBe('something.new')
  })

  it('has a chip for every action family and every outcome, worded as the pills are', () => {
    for (const prefix of AUDIT_PREFIXES) expect(PREFIX_LABEL[prefix]).toBeTruthy()
    for (const outcome of AUDIT_OUTCOMES) {
      expect(OUTCOME_CHIP[outcome]).toBe(AUDIT_OUTCOME_LABEL[outcome])
    }
  })

  it('names a target, or says there was none', () => {
    expect(targetLabel('ssl_job')).toBe('Certificate job')
    expect(targetLabel('customer_search')).toBe('Customer search')
    expect(targetLabel('new_kind')).toBe('new kind')
    expect(targetLabel(null)).toBe('Nothing named')
  })

  it('words the gateway’s result as §5.2 does', () => {
    expect(gatewayResult(null)).toBe('No result recorded')
    expect(gatewayResult({ outcome: 'ok', errorCode: null })).toBe('Read: ok')
    expect(gatewayResult({ outcome: 'refused', errorCode: 'TOO_SOON' })).toBe('Refused: TOO_SOON')
    expect(gatewayResult({ outcome: 'failed', errorCode: 'SUPPLIER_BUSY' })).toBe(
      'Failed: SUPPLIER_BUSY',
    )
    expect(gatewayResult({ outcome: 'refused', errorCode: null })).toBe('Refused')
  })
})

describe('auditTargetHref', () => {
  it('links a record by its id, to the page that shows it', () => {
    const cases: [string, string, string][] = [
      ['refund', UUID, `/admin/refunds/${UUID}`],
      ['incident', '12', '/admin/refunds/incidents?id=12#incident-12'],
      ['job', UUID, `/admin/queue/jobs/${UUID}`],
      ['ssl_job', UUID, `/admin/queue/ssl-jobs/${UUID}`],
      ['domain', UUID, `/admin/domains/${UUID}`],
      ['customer', UUID, `/admin/customers/${UUID}`],
      ['certificate', UUID, `/admin/ssl/${UUID}`],
      ['preset', UUID, `/admin/settings/presets/${UUID}`],
      ['preset_draft', UUID, '/admin/settings/presets?status=draft'],
      ['ledger', UUID.toUpperCase(), `/admin/supplier/ledger?trace=${UUID}`],
      ['audit', '7', '/admin/audit?id=7'],
      ['fx_rate', UUID, '/admin/pricing/fx'],
      ['pricing_settings', 'global', '/admin/pricing'],
      ['ops_settings', 'global', '/admin/settings'],
    ]
    for (const [type, id, href] of cases) expect(auditTargetHref({ type, id }), type).toBe(href)
  })

  it('never puts a name in a link: a lookup’s domain is shown, not linked (N13)', () => {
    expect(auditTargetHref({ type: 'domain', id: 'shop.example.com' })).toBeNull()
    expect(auditTargetHref({ type: 'certificate', id: '*.example.com' })).toBeNull()
    expect(auditTargetHref({ type: 'refund', id: 'not-an-id' })).toBeNull()
    expect(auditTargetHref({ type: 'incident', id: 'x' })).toBeNull()
    expect(auditTargetHref({ type: 'ledger', id: null })).toBeNull()
    expect(auditTargetHref({ type: 'audit', id: 'x' })).toBeNull()
    for (const type of ['job', 'ssl_job', 'customer', 'preset']) {
      expect(auditTargetHref({ type, id: 'name' }), type).toBeNull()
    }
  })

  it('links nothing it has no page for', () => {
    expect(auditTargetHref({ type: 'supplier', id: 'test' })).toBeNull()
    expect(auditTargetHref({ type: 'email', id: UUID })).toBeNull()
    expect(auditTargetHref({ type: null, id: UUID })).toBeNull()
  })
})

describe('auditTargetText', () => {
  it('shortens an id and shows a name whole', () => {
    expect(auditTargetText({ type: 'refund', id: UUID })).toBe('Refund 7a7b7c7d')
    expect(auditTargetText({ type: 'domain', id: 'shop.example.com' })).toBe(
      'Domain shop.example.com',
    )
    expect(auditTargetText({ type: 'supplier', id: 'test' })).toBe('Supplier · test')
    expect(auditTargetText({ type: 'customer_search', id: null })).toBe('Customer search')
  })

  it('masks an email and cuts a long value', () => {
    expect(auditTargetText({ type: 'customer', id: 'ada@example.com' })).toBe(
      'Customer a•••@example.com',
    )
    expect(auditTargetText({ type: 'tld', id: 'x'.repeat(80) })).toBe(
      `Extension ${'x'.repeat(59)}…`,
    )
  })
})
