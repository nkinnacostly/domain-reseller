import { describe, expect, it } from 'vitest'
import {
  type BulkLine,
  bulkSummary,
  bulkTitle,
  describeLine,
  isBulkSettling,
  lineState,
} from '../lib/bulk'

function line(overrides: Partial<BulkLine> = {}): BulkLine {
  return {
    domainId: 'd1',
    domainName: 'getpaid.com',
    outcome: 'queued',
    reason: null,
    jobStatus: 'queued',
    jobErrorCode: null,
    ...overrides,
  }
}

describe('lineState — what each line comes to (FR-P4)', () => {
  it('follows the job for a queued line', () => {
    expect(lineState(line({ jobStatus: 'queued' }))).toBe('waiting')
    expect(lineState(line({ jobStatus: 'running' }))).toBe('waiting')
    expect(lineState(line({ jobStatus: 'succeeded' }))).toBe('done')
    expect(lineState(line({ jobStatus: 'failed' }))).toBe('failed')
    expect(lineState(line({ jobStatus: 'needs_attention' }))).toBe('attention')
    expect(lineState(line({ jobStatus: null }))).toBe('waiting')
  })

  it('tells "already set" apart from a skip with a reason', () => {
    expect(lineState(line({ outcome: 'done', jobStatus: null }))).toBe('done')
    expect(lineState(line({ outcome: 'skipped', reason: 'unchanged' }))).toBe('unchanged')
    expect(lineState(line({ outcome: 'skipped', reason: 'demo' }))).toBe('skipped')
  })
})

describe('isBulkSettling', () => {
  it('keeps refreshing only while a job is queued or running', () => {
    expect(isBulkSettling([line({ jobStatus: 'running' })])).toBe(true)
    expect(isBulkSettling([line({ jobStatus: 'queued' })])).toBe(true)
    expect(
      isBulkSettling([
        line({ jobStatus: 'succeeded' }),
        line({ jobStatus: 'needs_attention' }),
        line({ outcome: 'done', jobStatus: null }),
      ]),
    ).toBe(false)
    // A line whose job is gone cannot move, so it never holds the page open.
    expect(isBulkSettling([line({ jobStatus: null })])).toBe(false)
  })
})

describe('bulkSummary', () => {
  it('counts every state', () => {
    expect(
      bulkSummary([
        line({ jobStatus: 'succeeded' }),
        line({ outcome: 'done' }),
        line({ jobStatus: 'queued' }),
        line({ jobStatus: 'failed' }),
        line({ outcome: 'skipped', reason: 'unchanged' }),
        line({ outcome: 'skipped', reason: 'demo' }),
        line({ jobStatus: 'needs_attention' }),
      ]),
    ).toEqual({ done: 2, waiting: 1, attention: 1, failed: 1, unchanged: 1, skipped: 1 })
  })
})

describe('bulkTitle', () => {
  it('says what was asked, and of how many', () => {
    expect(bulkTitle('nameservers', { nameservers: ['a'] }, 3)).toBe(
      'New nameservers for 3 domains',
    )
    expect(bulkTitle('transfer_lock', { locked: true }, 1)).toBe('Transfer lock on for 1 domain')
    expect(bulkTitle('transfer_lock', { locked: false }, 2)).toBe('Transfer lock off for 2 domains')
    expect(bulkTitle('privacy', { enabled: true }, 2)).toBe('Contact privacy on for 2 domains')
    expect(bulkTitle('auto_renew', { enabled: false }, 2)).toBe('Auto-renew off for 2 domains')
    expect(bulkTitle('label', { label_id: 'l1' }, 2, 'Acme')).toBe(
      'Label “Acme” added to 2 domains',
    )
    expect(bulkTitle('unlabel', { label_id: 'l1' }, 2)).toBe('Label a label removed from 2 domains')
  })
})

describe('describeLine — each outcome in words, never the supplier’s (N10)', () => {
  it('follows a queued job to the registry and back', () => {
    const kind = 'transfer_lock'
    const params = { locked: true }
    expect(describeLine(kind, params, line({ jobStatus: 'queued' }))).toBe(
      'Queued for the registry.',
    )
    expect(describeLine(kind, params, line({ jobStatus: 'running' }))).toBe(
      'Being applied at the registry now.',
    )
    expect(describeLine(kind, params, line({ jobStatus: 'succeeded' }))).toBe(
      'The registry confirmed it.',
    )
    expect(describeLine(kind, params, line({ jobStatus: 'needs_attention' }))).toBe(
      'Held for a person to check at the registry. Nothing is needed from you.',
    )
    expect(
      describeLine(kind, params, line({ jobStatus: 'failed', jobErrorCode: 'DOMAIN_NOT_FOUND' })),
    ).toBe('The registry does not list this domain in our account.')
    expect(
      describeLine(kind, params, line({ jobStatus: 'failed', jobErrorCode: 'SOMETHING_RAW' })),
    ).toBe('The registry could not complete it.')
    expect(describeLine(kind, params, line({ jobStatus: null }))).toBe('Sent to the registry.')
  })

  it('says why a domain was skipped', () => {
    const skipped = (reason: string, kind: Parameters<typeof describeLine>[0] = 'privacy') =>
      describeLine(kind, { enabled: true }, line({ outcome: 'skipped', reason, jobStatus: null }))
    expect(skipped('demo')).toBe('A demo domain never reaches a registry.')
    expect(skipped('registering')).toBe(
      'It is still registering. Change it once the registration completes.',
    )
    expect(skipped('not_active')).toBe('Only a registered domain can be changed.')
    expect(skipped('not_active', 'nameservers')).toBe(
      'Nameservers can only be changed on an active domain.',
    )
    expect(skipped('change_waiting')).toBe('A change is already on its way to the registry.')
    expect(
      describeLine(
        'privacy',
        { enabled: true },
        line({ outcome: 'skipped', reason: 'not_offered', domainName: 'naija.com.ng' }),
      ),
    ).toBe('Contact privacy is not offered for .com.ng domains.')
    expect(skipped('something_new')).toBe('It was left as it is.')
  })

  it('says a domain already had what was asked for, per action', () => {
    const unchanged = (kind: Parameters<typeof describeLine>[0], params = {}) =>
      describeLine(kind, params, line({ outcome: 'skipped', reason: 'unchanged' }))
    expect(unchanged('nameservers')).toBe('It already uses those nameservers.')
    expect(unchanged('transfer_lock', { locked: true })).toBe('It is already locked.')
    expect(unchanged('transfer_lock', { locked: false })).toBe('It is already unlocked.')
    expect(unchanged('privacy', { enabled: false })).toBe('Contact privacy is already off.')
    expect(unchanged('auto_renew', { enabled: true })).toBe('Auto-renew is already on.')
    expect(unchanged('label')).toBe('It already had this label.')
    expect(unchanged('unlabel')).toBe('It did not have this label.')
  })

  it('says what was done at once, and why a nameserver set did not go to a registry', () => {
    const done = (kind: Parameters<typeof describeLine>[0], params = {}, source = 'registration') =>
      describeLine(kind, params, line({ outcome: 'done', jobStatus: null }), {
        source,
        status: 'active',
      })
    expect(done('nameservers', {}, 'demo')).toBe(
      'Saved. This is a demo domain, so nothing is sent to a registry.',
    )
    expect(done('nameservers', {}, 'registration')).toBe(
      'Saved. Applied as soon as the registration completes.',
    )
    expect(done('auto_renew', { enabled: true })).toBe('Auto-renew turned on.')
    expect(done('label')).toBe('Label added.')
    expect(done('unlabel')).toBe('Label removed.')
    expect(done('privacy')).toBe('The registry confirmed it.')
  })
})
