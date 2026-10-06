import { describe, expect, it, vi } from 'vitest'
import { pickCapNotice } from '../lib/cap-notice'
import {
  applyTenantActions,
  type ClaimedTenantAction,
  describeSesFailure,
  resumeReason,
  type TenantActionStore,
  type TenantStatusSetter,
} from '../lib/tenant-actions'
import { bearerMatches } from '../lib/trigger'

/**
 * SES's side of a pause (MAIL-SPEC §7.4, §4.3, MR5): what is claimed is
 * applied with the manager key; what SES does not take goes back to the
 * queue with its status and error type only.
 */

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const ARN = 'arn:aws:ses:eu-west-2:085568227110:tenant/mdm-0123456789/t-123'

const action = (over: Partial<ClaimedTenantAction> = {}): ClaimedTenantAction => ({
  id: 7,
  accountId: ACCOUNT,
  accountShortId: '0123456789',
  tenant: 'mdm-0123456789',
  sendingStatus: 'DISABLED',
  why: 'threshold',
  requestedBy: 'system',
  attempt: 1,
  ...over,
})

function fakes(rows: unknown[], ses: Partial<TenantStatusSetter> = {}) {
  const recorded: { id: number; outcome: string; error: string | undefined }[] = []
  const store: TenantActionStore = {
    claim: vi.fn(async () => rows),
    record: vi.fn(async (id, _worker, outcome, error) => {
      recorded.push({ id, outcome, error })
    }),
  }
  const setter: TenantStatusSetter = {
    tenantArn: vi.fn(async () => ({ ok: true as const, arn: ARN })),
    setStatus: vi.fn(async () => ({ ok: true as const })),
    ...ses,
  }
  return { store, setter, recorded }
}

describe('applying tenant status changes', () => {
  it('pauses the tenant by its ARN and records it applied', async () => {
    const { store, setter, recorded } = fakes([action()])
    const run = await applyTenantActions({ store, ses: setter, worker: 'w' })
    expect(run).toEqual({ claimed: 1, applied: 1, retried: 0, unreadable: 0 })
    expect(setter.tenantArn).toHaveBeenCalledWith('mdm-0123456789')
    expect(setter.setStatus).toHaveBeenCalledWith(ARN, 'DISABLED', 'paused')
    expect(recorded).toEqual([{ id: 7, outcome: 'applied', error: undefined }])
    expect(store.claim).toHaveBeenCalledWith('w', 10)
  })

  it('resumes only what an admin asked for, with their label in the reason (MR5)', async () => {
    const resume = action({
      id: 8,
      sendingStatus: 'ENABLED',
      why: 'admin_resume',
      requestedBy: 'owner',
    })
    const { store, setter } = fakes([resume])
    await applyTenantActions({ store, ses: setter, worker: 'w', limit: 3 })
    expect(setter.setStatus).toHaveBeenCalledWith(ARN, 'ENABLED', resumeReason(resume))
    expect(resumeReason(resume)).toBe("Resumed in Mail's admin by owner (tenant action 8)")
  })

  it('sends back what SES did not take, with its status and type only', async () => {
    const log = { warn: vi.fn() }
    const { store, setter, recorded } = fakes([action(), action({ id: 9 })], {
      tenantArn: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404, code: 'NotFoundException' })
        .mockResolvedValueOnce({ ok: true, arn: ARN }),
      setStatus: vi.fn(async () => ({ ok: false as const, status: null, code: null })),
    })
    const run = await applyTenantActions({ store, ses: setter, worker: 'w', log })
    expect(run).toEqual({ claimed: 2, applied: 0, retried: 2, unreadable: 0 })
    expect(recorded).toEqual([
      { id: 7, outcome: 'retry', error: 'HTTP 404 NotFoundException' },
      { id: 9, outcome: 'retry', error: 'no answer' },
    ])
    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('never guesses at a claimed row it cannot read', async () => {
    const log = { warn: vi.fn() }
    const { store, setter, recorded } = fakes([{ id: 1, tenant: 'not-ours' }], {})
    const run = await applyTenantActions({ store, ses: setter, worker: 'w', log })
    expect(run).toEqual({ claimed: 1, applied: 0, retried: 0, unreadable: 1 })
    expect(setter.tenantArn).not.toHaveBeenCalled()
    expect(recorded).toEqual([])
  })

  it('words SES failures the way last_error keeps them', () => {
    expect(describeSesFailure({ status: 403, code: 'AccessDeniedException' })).toBe(
      'HTTP 403 AccessDeniedException',
    )
    expect(describeSesFailure({ status: 500, code: null })).toBe('HTTP 500')
  })
})

describe('the worker’s ping secret', () => {
  const SECRET = 'a'.repeat(40)

  it('takes exactly the shared bearer secret, and nothing without one configured', () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true)
    expect(bearerMatches(`  Bearer   ${SECRET} `, SECRET)).toBe(true)
    expect(bearerMatches(`Bearer ${SECRET}x`, SECRET)).toBe(false)
    expect(bearerMatches(SECRET, SECRET)).toBe(false)
    expect(bearerMatches(null, SECRET)).toBe(false)
    expect(bearerMatches(`Bearer ${SECRET}`, undefined)).toBe(false)
    expect(bearerMatches('Bearer short', 'short')).toBe(false)
  })
})

describe('the cap notice the dashboard shows (§8)', () => {
  const period = { day: '2026-10-06', monthStart: '2026-10-01' }
  const row = (scope: string, period_start: string, level: number) => ({
    scope,
    period_start,
    level,
    cap: 100,
    used: 90,
  })

  it('picks this day’s and month’s, the month at its cap first', () => {
    expect(pickCapNotice([row('day', '2026-10-06', 80)], period)).toEqual({
      scope: 'day',
      level: 80,
      cap: 100,
      used: 90,
    })
    expect(
      pickCapNotice(
        [
          row('day', '2026-10-06', 100),
          row('month', '2026-10-01', 80),
          row('month', '2026-10-01', 100),
        ],
        period,
      ),
    ).toMatchObject({ scope: 'month', level: 100 })
    expect(
      pickCapNotice([row('day', '2026-10-06', 100), row('month', '2026-10-01', 80)], period),
    ).toMatchObject({
      scope: 'day',
      level: 100,
    })
  })

  it('ignores other days, odd rows and an answer that is not a list', () => {
    expect(
      pickCapNotice([row('day', '2026-10-05', 100), row('month', '2026-09-01', 100)], period),
    ).toBeNull()
    expect(
      pickCapNotice(
        [row('week', '2026-10-06', 80), row('day', '2026-10-06', 90), { scope: 'day' }],
        period,
      ),
    ).toBeNull()
    expect(pickCapNotice({ rows: [] }, period)).toBeNull()
  })
})
