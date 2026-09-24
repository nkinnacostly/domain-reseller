import { describe, expect, it } from 'vitest'
import { isTransferOpen, STAGE_NOTE, transferStage } from '../lib/progress'

describe('transferStage (PRD E9)', () => {
  it.each([
    ['transfer_requested', 'waiting'],
    ['transfer_pending', 'at_registry'],
    ['transfer_rejected', 'not_transferred'],
    ['transfer_cancelled', 'not_transferred'],
    ['active', 'done'],
    ['expired_grace', 'done'],
  ] as const)('reads %s as %s', (status, stage) => {
    expect(transferStage(status)).toBe(stage)
  })

  it('keeps only a transfer still moving open', () => {
    expect(isTransferOpen('waiting')).toBe(true)
    expect(isTransferOpen('at_registry')).toBe(true)
    expect(isTransferOpen('done')).toBe(false)
    expect(isTransferOpen('not_transferred')).toBe(false)
  })

  it('promises a refund only when money moved', () => {
    expect(STAGE_NOTE.not_transferred(false)).toMatch(/refunded automatically/)
    expect(STAGE_NOTE.not_transferred(true)).toMatch(/no money moved/)
    expect(STAGE_NOTE.not_transferred(true)).not.toMatch(/refunded/)
  })

  it('says a transfer at the registry can take days, and may need the owner', () => {
    expect(STAGE_NOTE.at_registry(false)).toMatch(/5 days/)
    expect(STAGE_NOTE.at_registry(false)).toMatch(/approve/)
    expect(STAGE_NOTE.waiting(false)).toMatch(/Paid/)
  })

  it('names the test system for a test transfer', () => {
    expect(STAGE_NOTE.done(true)).toMatch(/test system/)
    expect(STAGE_NOTE.done(false)).toBe('Transferred. It’s on your account.')
  })
})
